// Bundles the CLI + MCP stdio server to plain JS (build-cli/) so they run on Node builds without TypeScript
// support (e.g. distro packages). Dependencies stay external (node_modules).
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
	configFile: false,
	build: {
		ssr: true, outDir: 'build-cli', emptyOutDir: true, target: 'node22', minify: false, sourcemap: false,
		rollupOptions: { input: { main: 'cli/main.ts' }, output: { entryFileNames: '[name].js', format: 'es' }, external: [/^node:/, ...builtinModules, /^@modelcontextprotocol\//, 'zod'] }
	},
	ssr: { noExternal: [] }
});
