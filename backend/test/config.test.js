import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configurationModule = "import('./src/config.js').then(({ config }) => console.log(JSON.stringify({ demoMode: config.demoMode, deepgramApiKey: config.deepgramApiKey, deeplApiKey: config.deeplApiKey, groqModel: config.groqModel })))";
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

test('production config trims provider key line endings and rejects embedded control characters', () => {
  const trailingNewline = loadConfiguration({
    ...productionEnvironment,
    DEEPGRAM_API_KEY: 'test-deepgram-key\r\n',
  });

  test('production config migrates the retired Groq model to its supported replacement', () => {
    const retiredModel = loadConfiguration({
      ...productionEnvironment,
      GROQ_MODEL: 'llama-3.3-70b-versatile',
    });
    assert.equal(retiredModel.status, 0, retiredModel.stderr);
    assert.match(retiredModel.stdout, /"groqModel":"openai\/gpt-oss-120b"/);
    assert.match(retiredModel.stderr, /is retired; using openai\/gpt-oss-120b/);

    const defaultModel = loadConfiguration({
      ...productionEnvironment,
      GROQ_MODEL: '',
    });
    assert.equal(defaultModel.status, 0, defaultModel.stderr);
    assert.match(defaultModel.stdout, /"groqModel":"openai\/gpt-oss-120b"/);
  });
  assert.equal(trailingNewline.status, 0, trailingNewline.stderr);
  assert.match(trailingNewline.stdout, /"deepgramApiKey":"test-deepgram-key"/);

  const embeddedNewline = loadConfiguration({
    ...productionEnvironment,
    DEEPGRAM_API_KEY: 'test-deepgram\n-key',
  });
  assert.notEqual(embeddedNewline.status, 0);
  assert.match(embeddedNewline.stderr, /DEEPGRAM_API_KEY contains invalid characters/);

  const deeplTrailingNewline = loadConfiguration({
    ...productionEnvironment,
    DEEPL_API_KEY: 'test-deepl-key\r\n',
  });
  assert.equal(deeplTrailingNewline.status, 0, deeplTrailingNewline.stderr);
  assert.match(deeplTrailingNewline.stdout, /"deeplApiKey":"test-deepl-key"/);

  const deeplEmbeddedNewline = loadConfiguration({
    ...productionEnvironment,
    DEEPL_API_KEY: 'test-deepl\n-key',
  });
  assert.notEqual(deeplEmbeddedNewline.status, 0);
  assert.match(deeplEmbeddedNewline.stderr, /DEEPL_API_KEY contains invalid characters/);
});
