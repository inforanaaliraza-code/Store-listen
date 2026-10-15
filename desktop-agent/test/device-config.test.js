const { isDeviceSessionExpired, migrateSavedApiBase } = require('../src/device-config');
const assert = require('node:assert/strict');
const test = require('node:test');

test('packaged API origin replaces a stale saved host without changing device credentials', () => {
  const saved = {
    apiBase: 'http://localhost:8000',
    deviceId: 'device-001',
    encryptedSecret: 'encrypted-device-secret',
  };

  const migrated = migrateSavedApiBase(saved, {
    isPackaged: true,
    apiBase: 'https://api.example.com',
    error: '',
  });

  assert.deepEqual(migrated, {
    apiBase: 'https://api.example.com',
    deviceId: 'device-001',
    encryptedSecret: 'encrypted-device-secret',
  });
  assert.equal(saved.apiBase, 'http://localhost:8000');
});

test('development and invalid packaged configuration preserve the saved API host', () => {
  const saved = { apiBase: 'http://localhost:8000' };

  assert.equal(migrateSavedApiBase(saved, { isPackaged: false, apiBase: 'https://api.example.com' }), saved);
  assert.equal(migrateSavedApiBase(saved, { isPackaged: true, apiBase: '', error: 'Invalid release config' }), saved);
});

test('recognizes rejected device sessions without treating network errors as expired', () => {
  assert.equal(isDeviceSessionExpired(new Error('Invalid or expired session')), true);
  assert.equal(isDeviceSessionExpired(new Error('fetch failed')), false);
});