import { CATEGORIES, OBSERVATIONS, RESEARCH_AREAS, TAXONOMY_VERSION, TECHNIQUES } from '../taxonomy.ts';
import type { Profile } from './types.ts';
import type { Prepared } from './prepare.ts';

export const PROMPT_VERSION = 'vi-prompt/1';

const terms = (t: { key: string; hint: string }[]) => t.map((x) => `  - ${x.key}: ${x.hint}`).join('\n');

export interface PromptVideo {
	uid: string;
	creator?: string | null;
	caption?: string | null;
	duration_s?: number | null;
	width?: number | null;
	height?: number | null;
	fps?: number | null;
	video_codec?: string | null;
	has_audio?: boolean | null;
	source_kind?: string | null;
}

/** `readInstruction` differs per provider: some read file paths with a tool, others receive attached images. */
export function buildPrompt(video: PromptVideo, profile: Profile, prep: Prepared, readInstruction: 'read-files' | 'attached'): string {
	const frameList = prep.frames
		.map((f) => `  frame ${f.index} — t=${f.t.toFixed(2)}s (${f.kind})${readInstruction === 'read-files' ? ` — ${f.path}` : ''}`)
		.join('\n');
	const shotList = prep.shots?.length ? prep.shots.map((s, i) => `  shot ${i + 1}: ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s`).join('\n') : '  (not computed)';
	const depth: Record<string, string> = {
		quick: 'QUICK TRIAGE. Decide what this probably is and whether deeper inspection is worthwhile. Keep it brief.',
		standard: 'STANDARD ANALYSIS. Give structured labels with evidence per label (cite frame numbers and timestamps).',
		deep: 'DEEP PRODUCTION RESEARCH. As standard, plus: plausible production workflow, editing/camera/lighting/render approaches and how someone could reproduce the look. Everything about the workflow is INFERENCE from stills, never proof.'
	};
	return `You are a visual-production analyst helping a researcher learn how short videos were designed and made.
${depth[profile.id] ?? ''}

VIDEO (uid ${video.uid})
  creator: ${video.creator ?? 'unknown'}
  caption: ${video.caption ? JSON.stringify(video.caption.slice(0, 500)) : 'unknown'}
  duration: ${video.duration_s ? video.duration_s.toFixed(1) + 's' : 'unknown'}, resolution: ${video.width ?? '?'}x${video.height ?? '?'}, fps: ${video.fps ?? 'unknown'}, codec: ${video.video_codec ?? 'unknown'}, audio: ${video.has_audio == null ? 'unknown' : video.has_audio ? 'yes' : 'no'}
  collected from: ${video.source_kind ?? 'unknown'}

EVIDENCE YOU ARE GIVEN (${readInstruction === 'read-files' ? 'view every image file listed, using your file-reading tool' : 'the images attached to this message, in this order'}):
${frameList}
${prep.sheet ? `  contact sheet${readInstruction === 'read-files' ? ` — ${prep.sheet.path}` : ''}: ${prep.sheet.cols} columns, cells in reading order = frames in order (cell n = frame n)\n` : ''}Detected shots:
${shotList}

HARD LIMITS OF THIS EVIDENCE
${prep.limitations.map((l) => '  - ' + l).join('\n')}
Never claim to have watched the whole video. State what you could not see in "limitations".

HOW TO JUDGE
  - A video may have MANY labels at once (e.g. a 3D motion-graphics product ad that is also a composited render).
  - Separate what you SEE from what you INFER. Every label needs evidence: frame number and/or timestamp plus a short note.
  - Use certainty "observed" only for things directly visible in a frame, "likely" for strong inference, "possible" otherwise.
  - Never assert specific software, products, cameras or equipment as fact. Say "possible phone-filmed computer display", not "an iPhone filming a MacBook"; say "genjutsu_like_transition", never that a named product was used.
  - If you cannot tell, use category "unknown" and say why. Do not invent. Low confidence is a good answer.
  - Judge research usefulness for: ${RESEARCH_AREAS.join(', ')}.

LABEL KEYS (use these keys exactly; if nothing fits you may add a new snake_case key and it will be stored as custom)
categories:
${terms(CATEGORIES)}
techniques:
${terms(TECHNIQUES)}
observations:
${terms(OBSERVATIONS)}

OUTPUT: reply with ONE JSON object and nothing else (no markdown fence), schema ${TAXONOMY_VERSION}:
{
  "summary": "2-4 sentences: what the video shows and how it appears to be made",
  "categories":   [{"key": "...", "confidence": 0-1, "certainty": "observed|likely|possible", "evidence": [{"t": seconds|null, "frame": n|null, "note": "..."}]}],
  "techniques":   [ ...same shape... ],
  "observations": [ ...same shape... ],
  "research": {"useful": "useful|not_useful|uncertain", "relevance": 0-1, "confidence": 0-1, "explanation": "...",
               "relevant_for": [areas], "suggested_methods": ["plausible production method (inference)"], "learnable": ["what a creator could learn"], "analyse_further": ["what deeper inspection should look at"]},
  "limitations": "what this evidence could not show"
}`;
}
