import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests never touch the real library: every run gets its own data directory.
const data = mkdtempSync(join(tmpdir(), 'vie-vitest-'));
export default defineConfig({
	test: {
		include: ['tests-js/**/*.test.ts'], environment: 'node', testTimeout: 60000, pool: 'forks', fileParallelism: false,
		env: { VIE_DATA_DIR: data, VIE_CONFIG: join(data, 'config.toml'), VIE_SESSIONS_DIR: join(data, 'no-sessions') }
	}
});
