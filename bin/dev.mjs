#!/usr/bin/env node
// `npm run dev`: development server on localhost with the exact URL printed. No credentials, no extra terminals.
import { createServer } from 'vite';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
	console.error(`Node >= 22.18 is required (found ${process.versions.node}). It provides the built-in SQLite and TypeScript support this app uses.`);
	process.exit(1);
}
const server = await createServer({ server: { host: '127.0.0.1' } });
await server.listen();
const addr = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;
console.log(`\n  Visual Intelligence Engine (dev) → ${addr}\n  Local only. No account needed. No AI runs unless you start an analysis.\n`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => (await server.close(), process.exit(0)));
