// One tiny, explicit provider smoke test: a generated 2-colour image and a one-line question. Only runs on request.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../paths.ts';
import { run } from '../exec.ts';
import { getProvider } from './providers/index.ts';

export async function testProvider(id: string, model?: string) {
	const provider = getProvider(id);
	const dir = mkdtempSync(join(tmpDir(), 'ptest-'));
	const img = join(dir, 'test_left_red_right_blue.png');
	try {
		const r = await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=128x128', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128', '-filter_complex', 'hstack', '-frames:v', '1', img], { timeoutMs: 20_000 });
		if (r.code !== 0) throw new Error('could not create the test image (is ffmpeg installed?)');
		const prompt = `${id === 'claude' || id === 'antigravity' ? `View the image file ${img}.` : 'Look at the attached image.'} It has two halves. Reply with ONLY this JSON, no prose: {"left":"<colour of the left half>","right":"<colour of the right half>"}`;
		const t0 = Date.now();
		const ac = new AbortController();
		const resp = await provider.run({ prompt, images: [img], schema: { type: 'object', additionalProperties: false, required: ['left', 'right'], properties: { left: { type: 'string' }, right: { type: 'string' } } }, model, timeoutMs: 180_000, workdir: dir }, ac.signal);
		const j = resp.json ?? {};
		const sees = /red/i.test(j.left ?? '') && /blue/i.test(j.right ?? '');
		return { ok: true, imageUnderstanding: sees, answer: j, model: resp.model, usage: resp.usage, wallMs: Date.now() - t0 };
	} catch (e: any) {
		return { ok: false, error: String(e.message ?? e) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
