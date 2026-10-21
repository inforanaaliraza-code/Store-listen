import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configurationModule = "import('./src/config.js').then(({ config }) => console.log(JSON.stringify({ demoMode: config.demoMode })))";
const productionEnvironment = {
  ...process.env,
  APP_ENV: 'production',
  JWT_SECRET: 'test-production-jwt-secret-that-is-longer-than-thirty-two',
  MONGODB_URI: 'mongodb+srv://test:test@cluster.example.invalid/storelisten',
  DEEPGRAM_API_KEY: 'test-deepgram-key',
  STORAGE_PROVIDER: 'gridfs',
  DEMO_MODE: 'false',
  POS_PROVIDER: 'none',
};

function loadConfiguration(environment) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', configurationModule], {
    cwd: backendDirectory,
    env: environment,
    encoding: 'utf8',
  });
}

test('production config fails closed without Deepgram or durable GridFS storage', () => {
  const missingDeepgram = loadConfiguration({ ...productionEnvironment, DEEPGRAM_API_KEY: '' });
  assert.notEqual(missingDeepgram.status, 0);
  assert.match(missingDeepgram.stderr, /DEEPGRAM_API_KEY is required in production/);

  const localAudioStorage = loadConfiguration({ ...productionEnvironment, STORAGE_PROVIDER: 'local' });
  assert.notEqual(localAudioStorage.status, 0);
  assert.match(localAudioStorage.stderr, /STORAGE_PROVIDER=gridfs is required in production/);

  const requestedDemoMode = loadConfiguration({ ...productionEnvironment, DEMO_MODE: 'true' });
  assert.equal(requestedDemoMode.status, 0, requestedDemoMode.stderr);
  assert.match(requestedDemoMode.stderr, /DEMO_MODE=true is ignored in production/);
  assert.match(requestedDemoMode.stdout, /"demoMode":false/);

  const mockPos = loadConfiguration({ ...productionEnvironment, POS_PROVIDER: 'mock' });
  assert.notEqual(mockPos.status, 0);
  assert.match(mockPos.stderr, /POS_PROVIDER=mock is not allowed in production/);

  const validProductionConfig = loadConfiguration(productionEnvironment);
  assert.equal(validProductionConfig.status, 0, validProductionConfig.stderr);
});
