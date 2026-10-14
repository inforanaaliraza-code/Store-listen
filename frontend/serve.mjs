import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const host = (process.env.HOST || '127.0.0.1').trim();
const port = Number((process.env.PORT || '3000').trim());
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }

  const resolvedPath = path.resolve(root, `.${requestedPath}`);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }

  let filePath = resolvedPath;
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) filePath = path.join(root, 'index.html');
  } catch {
    filePath = path.join(root, 'index.html');
  }

  try {
    const fileInfo = await stat(filePath);
    const isHtml = filePath.endsWith('.html');
    response.writeHead(200, {
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Content-Length': fileInfo.size,
      'Content-Type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(503).end('Dashboard build is not available.');
  }
});

server.listen(port, host, () => {
  console.log(`Store Listen dashboard listening on http://${host}:${port}`);
});