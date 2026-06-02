/**
 * Unit tests for atomic refresh-token session store (multi-device safety).
 * Run: node scripts/test-refresh-token-session.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const refreshTokenSession = require('../services/refreshTokenSession.service');

function signRefresh(userId) {
  return jwt.sign(
    { id: userId, type: 'refresh', jti: `${Date.now()}_${Math.random()}` },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: '7d' }
  );
}

async function createTempUser() {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return User.create({
    name: 'Refresh Session Test',
    email: `refresh_test_${suffix}@example.com`,
    phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    password: 'TestPass123!',
    userType: 'admin',
    role: 'admin',
    status: 'active',
    isEmailVerified: true,
    isPhoneVerified: true
  });
}

async function testMultiDeviceAppendAndLookup() {
  const user = await createTempUser();
  const tokenA = signRefresh(user._id);
  const tokenB = signRefresh(user._id);
  const hashA = refreshTokenSession.hashRefreshToken(tokenA);
  const hashB = refreshTokenSession.hashRefreshToken(tokenB);

  await refreshTokenSession.appendSession(user._id, { hashedToken: hashA, deviceInfo: 'Device-A' });
  await refreshTokenSession.appendSession(user._id, { hashedToken: hashB, deviceInfo: 'Device-B' });

  const sessionA = await refreshTokenSession.lookupSession(tokenA);
  const sessionB = await refreshTokenSession.lookupSession(tokenB);

  assert.ok(sessionA, 'Device A session should resolve');
  assert.ok(sessionB, 'Device B session should resolve');
  assert.strictEqual(sessionA.matchKind, 'active');
  assert.strictEqual(sessionB.matchKind, 'active');

  await User.deleteOne({ _id: user._id });
}

async function testLoginDoesNotInvalidateExistingDeviceAfterRotation() {
  const user = await createTempUser();
  const tokenA = signRefresh(user._id);
  const hashA = refreshTokenSession.hashRefreshToken(tokenA);

  await refreshTokenSession.appendSession(user._id, { hashedToken: hashA, deviceInfo: 'Device-A' });

  const plainNewA = signRefresh(user._id);
  const newHashA = refreshTokenSession.hashRefreshToken(plainNewA);
  const rotation = await refreshTokenSession.rotateSession(user._id, hashA, newHashA, 'Device-A');
  assert.strictEqual(rotation.rotated, true);

  const tokenB = signRefresh(user._id);
  const hashB = refreshTokenSession.hashRefreshToken(tokenB);
  await refreshTokenSession.appendSession(user._id, { hashedToken: hashB, deviceInfo: 'Device-B' });

  const sessionA = await refreshTokenSession.lookupSession(plainNewA);
  const sessionB = await refreshTokenSession.lookupSession(tokenB);
  assert.ok(sessionA, 'Device A rotated session must survive Device B login');
  assert.ok(sessionB, 'Device B session must resolve');

  await User.deleteOne({ _id: user._id });
}

async function testReplayGraceAfterRotation() {
  const user = await createTempUser();
  const tokenA = signRefresh(user._id);
  const hashA = refreshTokenSession.hashRefreshToken(tokenA);

  await refreshTokenSession.appendSession(user._id, { hashedToken: hashA, deviceInfo: 'Device-A' });

  const plainNewA = signRefresh(user._id);
  const newHashA = refreshTokenSession.hashRefreshToken(plainNewA);
  const rotation = await refreshTokenSession.rotateSession(user._id, hashA, newHashA, 'Device-A');
  assert.strictEqual(rotation.rotated, true);

  const replay = await refreshTokenSession.lookupSession(tokenA);
  assert.ok(replay, 'Old refresh cookie should match replay grace window');
  assert.strictEqual(replay.matchKind, 'replay');

  await User.deleteOne({ _id: user._id });
}

async function testRevokeSingleDeviceLeavesOther() {
  const user = await createTempUser();
  const tokenA = signRefresh(user._id);
  const tokenB = signRefresh(user._id);
  const hashA = refreshTokenSession.hashRefreshToken(tokenA);
  const hashB = refreshTokenSession.hashRefreshToken(tokenB);

  await refreshTokenSession.appendSession(user._id, { hashedToken: hashA, deviceInfo: 'Device-A' });
  await refreshTokenSession.appendSession(user._id, { hashedToken: hashB, deviceInfo: 'Device-B' });

  await refreshTokenSession.revokeSessionByTokenHash(user._id, hashA);

  assert.strictEqual(await refreshTokenSession.lookupSession(tokenA), null);
  assert.ok(await refreshTokenSession.lookupSession(tokenB));

  await User.deleteOne({ _id: user._id });
}

async function run() {
  if (!process.env.MONGO_DB_URI) {
    console.error('MONGO_DB_URI required');
    process.exit(1);
  }
  if (!process.env.REFRESH_TOKEN_SECRET || !process.env.JWT_SECRET) {
    console.error('JWT secrets required');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_DB_URI);

  await testMultiDeviceAppendAndLookup();
  await testLoginDoesNotInvalidateExistingDeviceAfterRotation();
  await testReplayGraceAfterRotation();
  await testRevokeSingleDeviceLeavesOther();

  await mongoose.disconnect();
  console.log('All refresh-token session tests passed.');
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
