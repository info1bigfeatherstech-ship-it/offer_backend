/**
 * Auth refresh diagnostic — traces 15m logout chain without changing app code.
 * Run: node scripts/test-auth-refresh-diagnostic.js
 * Optional: ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/...
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const API = process.env.TEST_API_BASE || 'http://localhost:8081/api';
const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';

function decodeExp(token) {
  const p = jwt.decode(token);
  if (!p?.exp) return null;
  return { exp: new Date(p.exp * 1000).toISOString(), ttlSec: p.exp - Math.floor(Date.now() / 1000) };
}

async function req(path, { method = 'GET', body, cookie, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, setCookie };
}

function cookieHeaderFromSetCookies(setCookies) {
  return setCookies
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function main() {
  console.log('=== Auth refresh diagnostic ===\n');
  console.log('API:', API);
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('ACCESS_TOKEN_EXPIRES (env or default):', ACCESS_EXPIRES);
  console.log('COOKIE_DOMAIN:', process.env.COOKIE_DOMAIN || '(not set)');
  console.log('COOKIE_SAMESITE:', process.env.COOKIE_SAMESITE || '(default by NODE_ENV)');
  console.log('');

  // 1) Refresh without cookie — reproduces browser when cookie not sent
  const noCookie = await req('/auth/refresh', {
    method: 'POST',
    body: { portal: 'admin-ecomm' },
    origin: 'http://localhost:5173',
  });
  console.log('1) POST /auth/refresh (no cookie, Origin:5173)');
  console.log('   status:', noCookie.status, '| code:', noCookie.json?.code);
  console.log('   → Same as console 401 when refresh cookie missing\n');

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('2) Login+refresh cycle SKIPPED — set ADMIN_EMAIL and ADMIN_PASSWORD to run full cycle.\n');
    console.log('=== Chain summary (code-traced) ===');
    printChainSummary();
    return;
  }

  const login = await req('/auth/login', {
    method: 'POST',
    body: { identifier: email, password, portal: 'admin-ecomm' },
    origin: 'http://localhost:5173',
  });
  console.log('2) POST /auth/login (admin-ecomm)');
  console.log('   status:', login.status);
  if (login.status !== 200) {
    console.log('   body:', login.json);
    return;
  }
  const cookie = cookieHeaderFromSetCookies(login.setCookie);
  const adminCookie = login.setCookie.find((c) => c.includes('refreshToken_admin_ecomm'));
  console.log('   Set-Cookie admin:', adminCookie ? adminCookie.split(';').slice(0, 4).join('; ') : 'MISSING');
  console.log('   access TTL:', decodeExp(login.json.accessToken));
  console.log('');

  const refreshOk = await req('/auth/refresh', {
    method: 'POST',
    body: { portal: 'admin-ecomm' },
    cookie,
    origin: 'http://localhost:5173',
  });
  console.log('3) POST /auth/refresh (with login cookie)');
  console.log('   status:', refreshOk.status, '| code:', refreshOk.json?.code);
  if (refreshOk.status === 200) {
    console.log('   new access TTL:', decodeExp(refreshOk.json.accessToken));
  }
  console.log('');

  const newCookie = refreshOk.setCookie?.length
    ? cookieHeaderFromSetCookies(refreshOk.setCookie)
    : cookie;

  const me = await req('/auth/me', {
    cookie,
    origin: 'http://localhost:5173',
    headers: { Authorization: `Bearer ${login.json.accessToken}` },
  });
  // fix me request with auth header
  const meRes = await fetch(`${API}/auth/me`, {
    headers: {
      'Content-Type': 'application/json',
      Cookie: newCookie,
      Authorization: `Bearer ${refreshOk.status === 200 ? refreshOk.json.accessToken : login.json.accessToken}`,
      Origin: 'http://localhost:5173',
    },
  });
  const meJson = await meRes.json();
  console.log('4) GET /auth/me (valid access token)');
  console.log('   status:', meRes.status);
  console.log('');

  // Expired access simulation
  const expired = jwt.sign(
    { id: '000000000000000000000000', type: 'access', userType: 'admin', role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '0s' }
  );
  await new Promise((r) => setTimeout(r, 1100));
  const meExpired = await fetch(`${API}/auth/me`, {
    headers: {
      Cookie: newCookie,
      Authorization: `Bearer ${expired}`,
      Origin: 'http://localhost:5173',
    },
  });
  console.log('5) GET /auth/me (expired access token) → triggers refresh in browser');
  console.log('   status:', meExpired.status, '(expect 401)\n');

  const refreshAfter = await req('/auth/refresh', {
    method: 'POST',
    body: { portal: 'admin-ecomm' },
    cookie: newCookie,
    origin: 'http://localhost:5173',
  });
  console.log('6) POST /auth/refresh after rotation');
  console.log('   status:', refreshAfter.status, '| code:', refreshAfter.json?.code);
  if (refreshAfter.json?.code === 'SESSION_EXPIRED') {
    console.log('   ⚠ ROTATION BUG: old cookie no longer in DB after successful refresh #3\n');
  }

  // Stale cookie (simulate browser kept old cookie)
  const staleRefresh = await req('/auth/refresh', {
    method: 'POST',
    body: { portal: 'admin-ecomm' },
    cookie, // original pre-rotation cookie
    origin: 'http://localhost:5173',
  });
  console.log('7) POST /auth/refresh with OLD cookie (after rotation)');
  console.log('   status:', staleRefresh.status, '| code:', staleRefresh.json?.code);
  console.log('   → If browser did not store new Set-Cookie, next 15m cycle gets this\n');

  printChainSummary();
}

function printChainSummary() {
  console.log('=== Where errors come from (traced in repo) ===\n');
  console.log('A) auth.controller.js ACCESS_EXPIRES default "15m" → access JWT dies ~15 min');
  console.log('B) auth.middleware verifyToken → 401 TokenExpiredError on protected routes');
  console.log('C) axiosInstance.js response interceptor → on 401 calls POST /auth/refresh');
  console.log('D) auth.controller refreshAccessToken → 401 codes:');
  console.log('     REFRESH_TOKEN_MISSING | REFRESH_TOKEN_INVALID | SESSION_EXPIRED');
  console.log('E) axiosInstance refresh catch → remove adminAccessToken + event auth:logout:admin');
  console.log('F) App.jsx → adminForceLogout() → login screen');
  console.log('G) adminAuthSlice getAdminMe.matchRejected → also clears token (parallel path)\n');
  console.log('Localhost cookie note: refresh cookie is stored for API host (localhost:8081),');
  console.log('NOT for Vite host (localhost:5173). Browser must send it on API requests only.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
