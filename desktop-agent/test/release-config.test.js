const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'scripts', 'build-release-config.js');

function runBuilder(apiBase, allowLocalHttp = false) {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'store-listen-release-'));
  const env = { ...process.env, STORE_LISTEN_RELEASE_CONFIG_OUTPUT_DIR: outputDirectory };
  if (apiBase === undefined) delete env.STORE_LISTEN_API_BASE_URL;
  else env.STORE_LISTEN_API_BASE_URL = apiBase;
  if (allowLocalHttp) env.STORE_LISTEN_ALLOW_LOCAL_HTTP = 'true';
  else delete env.STORE_LISTEN_ALLOW_LOCAL_HTTP;
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env });
  return { ...result, outputDirectory };
}

test('release config requires an HTTPS API origin', () => {
  const missing = runBuilder(undefined);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /STORE_LISTEN_API_BASE_URL/);
  fs.rmSync(missing.outputDirectory, { recursive: true, force: true });

  const insecure = runBuilder('http://api.example.com');
  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /HTTPS origin/);
  fs.rmSync(insecure.outputDirectory, { recursive: true, force: true });

  const localHttp = runBuilder('http://localhost:8000', true);
  try {
    assert.equal(localHttp.status, 0, localHttp.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(localHttp.outputDirectory, 'release-config.json'), 'utf8'));
    assert.deepEqual(config, { apiBase: 'http://localhost:8000' });
  } finally {
    fs.rmSync(localHttp.outputDirectory, { recursive: true, force: true });
  }
});

test('release config stores only the public API origin', () => {
  const result = runBuilder('https://api.example.com/v1?mode=test');
  try {
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, 'release-config.json'), 'utf8'));
    assert.deepEqual(config, { apiBase: 'https://api.example.com' });
  } finally {
    fs.rmSync(result.outputDirectory, { recursive: true, force: true });
  }
});
