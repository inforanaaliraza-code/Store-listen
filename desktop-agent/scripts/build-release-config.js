const fs = require('node:fs');
const path = require('node:path');

const suppliedUrl = String(process.env.STORE_LISTEN_API_BASE_URL || '').trim();
if (!suppliedUrl) {
  console.error('Set STORE_LISTEN_API_BASE_URL to the deployed HTTPS API before building a Windows package.');
  process.exit(1);
}

let apiBase;
try {
  const parsed = new URL(suppliedUrl);
  const allowLocalHttp = process.env.STORE_LISTEN_ALLOW_LOCAL_HTTP === 'true'
    && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !allowLocalHttp) || parsed.username || parsed.password) throw new Error();
  apiBase = parsed.origin;
} catch {
  console.error('STORE_LISTEN_API_BASE_URL must be an HTTPS origin. HTTP is allowed only for localhost when STORE_LISTEN_ALLOW_LOCAL_HTTP=true.');
  process.exit(1);
}

const outputDirectory = process.env.STORE_LISTEN_RELEASE_CONFIG_OUTPUT_DIR
  ? path.resolve(process.env.STORE_LISTEN_RELEASE_CONFIG_OUTPUT_DIR)
  : path.join(__dirname, '..', 'build');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'release-config.json'), JSON.stringify({ apiBase }, null, 2), { mode: 0o600 });
console.log(`Configured desktop release for ${new URL(apiBase).host}.`);
