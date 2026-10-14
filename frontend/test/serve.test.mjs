import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('production server serves deep links and built assets', async (context) => {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['serve.mjs'], {
    cwd: frontendRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  context.after(async () => {
    if (server.exitCode !== null) return;
    server.kill();
    await once(server, 'exit');
  });

  let pageResponse;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      pageResponse = await fetch(`http://127.0.0.1:${port}/live`);
      break;
    } catch (error) {
      lastError = error;
      await delay(40);
    }
  }

  if (!pageResponse) throw lastError;
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /<title>Store Listen<\/title>/);

  const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(scriptPath, 'production HTML should reference its application bundle');
  const scriptResponse = await fetch(`http://127.0.0.1:${port}${scriptPath}`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type') || '', /javascript/);
});