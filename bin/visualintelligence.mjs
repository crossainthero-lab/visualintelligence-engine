#!/usr/bin/env node
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
	console.error(`visualintelligence needs Node >= 22.18 (found ${process.versions.node}).`);
	process.exit(1);
}
process.removeAllListeners('warning');
process.on('warning', (w) => w.name !== 'ExperimentalWarning' && console.error(w));
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Prefer the compiled bundle (works on Node builds without TypeScript support); fall back to the sources in a dev checkout.
const built = fileURLToPath(new URL('../build-cli/main.js', import.meta.url));
const { main } = await import(existsSync(built) ? built : '../cli/main.ts');
process.exitCode = await main(process.argv.slice(2));
