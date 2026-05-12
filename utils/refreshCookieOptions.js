/**
 * Refresh-token cookie attributes resolver.
 *
 * Environment-aware behavior:
 *   - secure:   true  in production (HTTPS only), false in dev (HTTP localhost works)
 *   - sameSite: 'none' in production by default (allows cross-site cookie e.g.
 *               api.example.com from offerwaalebaba.com), 'lax' in dev.
 *               Override via COOKIE_SAMESITE=lax|strict|none for same-domain prod
 *               setups where 'lax' gives stronger CSRF protection.
 *   - domain:   only set in production when COOKIE_DOMAIN matches the response host
 *               (otherwise browsers silently drop Set-Cookie).
 *
 * Relevant env vars:
 *   NODE_ENV         development | production
 *   COOKIE_DOMAIN    e.g. ".offerwaalebaba.com" (production, optional)
 *   COOKIE_SAMESITE  lax | strict | none  (optional override)
 */

function normalizeHost(hostname) {
  if (!hostname) return '';
  return String(hostname).split(':')[0].trim().toLowerCase();
}

function cookieHostAllowsDomain(hostname, cookieDomainRaw) {
  const host = normalizeHost(hostname);
  if (!host || !cookieDomainRaw) return false;
  const domain = String(cookieDomainRaw).replace(/^\./, '').trim().toLowerCase();
  if (!domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function resolveSameSite(isProduction) {
  const raw = String(process.env.COOKIE_SAMESITE || '').trim().toLowerCase();
  if (raw === 'lax' || raw === 'strict' || raw === 'none') return raw;
  return isProduction ? 'none' : 'lax';
}

function getRefreshCookieOptions(req = null) {
  const isProduction = process.env.NODE_ENV === 'production';
  const sameSite = resolveSameSite(isProduction);

  // sameSite=none REQUIRES secure=true (browser spec). Force secure in that case.
  const secure = isProduction || sameSite === 'none';

  const options = {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };

  const rawDomain = String(process.env.COOKIE_DOMAIN || '').trim();
  if (isProduction && rawDomain && req) {
    const hostname = req.hostname || '';
    if (cookieHostAllowsDomain(hostname, rawDomain)) {
      options.domain = rawDomain.startsWith('.') ? rawDomain : `.${rawDomain.replace(/^\./, '')}`;
    }
  }

  return options;
}

module.exports = { getRefreshCookieOptions, cookieHostAllowsDomain };
