#!/usr/bin/env node
// `npm run start`: serve the production build (npm run build first). Safe by default:
//  - binds 127.0.0.1 unless you say otherwise
//  - refuses to bind a non-loopback address without VIE_AUTH_TOKEN, unless VIE_TRUSTED_LAN=1 is set explicitly
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'build', 'index.js');
if (!existsSync(entry)) {
	console.error('No production build found. Run:  npm run build');
	process.exit(1);
}
const host = process.env.VIE_HOST || '127.0.0.1';
const port = process.env.VIE_PORT || '3000';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!loopback && !process.env.VIE_AUTH_TOKEN && process.env.VIE_TRUSTED_LAN !== '1') {
	console.error(`Refusing to listen on ${host}: it is not a loopback address and no access control is configured.
  Either set VIE_AUTH_TOKEN=<long random secret> (recommended), or, on a network you trust, set VIE_TRUSTED_LAN=1 explicitly.
  Or keep VIE_HOST=127.0.0.1 and put an authenticating reverse proxy in front.`);
	process.exit(2);
}
if (!loopback) console.log(process.env.VIE_AUTH_TOKEN ? `Access token required for ${host}.` : `WARNING: ${host} is open to your LAN without authentication (VIE_TRUSTED_LAN=1).`);
process.env.HOST = host;
process.env.PORT = port;
if (process.env.VIE_ORIGIN) process.env.ORIGIN = process.env.VIE_ORIGIN; // only needed behind a TLS-terminating reverse proxy
process.env.BODY_SIZE_LIMIT ??= '8M';
console.log(`Visual Intelligence Engine → http://${host}:${port}`);
await import(pathToFileURL(entry).href);
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
