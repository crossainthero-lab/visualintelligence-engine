#!/usr/bin/env node
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
	console.error(`visualintelligence needs Node >= 22.18 (found ${process.versions.node}).`);
	process.exit(1);
}
process.removeAllListeners('warning');
process.on('warning', (w) => w.name !== 'ExperimentalWarning' && console.error(w));
const { main } = await import('../cli/main.ts');
process.exitCode = await main(process.argv.slice(2));
