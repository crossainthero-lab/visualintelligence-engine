// Versioned, extensible visual-production taxonomy. A video can carry many labels at once.
// Keys are stable identifiers; labels/descriptions are for humans. Add keys freely: unknown keys are stored
// as `custom:<key>` rather than rejected, so agents can note things the schema has not caught up with yet.
export const TAXONOMY_VERSION = 'vi-taxonomy/1';

export interface Term {
	key: string;
	label: string;
	hint: string;
}

export const CATEGORIES: Term[] = [
	{ key: 'ordinary_video', label: 'Ordinary Instagram video', hint: 'Everyday clip with no notable production technique' },
	{ key: 'motion_graphics', label: 'Motion graphics', hint: 'Designed animation of graphic elements, type or shapes' },
	{ key: 'motion_graphics_2d', label: '2D motion graphics', hint: 'Flat vector/raster animation' },
	{ key: 'motion_graphics_2_5d', label: '2.5D motion graphics', hint: 'Layered 2D with parallax / pseudo-depth' },
	{ key: 'motion_graphics_3d', label: '3D motion graphics', hint: 'Animated 3D objects/type as graphic design' },
	{ key: 'cgi', label: 'CGI', hint: 'Computer-generated imagery of any kind' },
	{ key: 'raw_3d_render', label: 'Raw 3D render', hint: 'Viewport/preview or unfinished render, minimal post' },
	{ key: 'composited_render', label: 'Composited render', hint: 'Render graded/composited with extra passes or footage' },
	{ key: 'ai_generated_film', label: 'AI-generated film', hint: 'Image/video-model output (text/image/video-to-video)' },
	{ key: 'live_action', label: 'Live-action filmmaking', hint: 'Camera footage of real subjects' },
	{ key: 'hybrid_ai_live_action', label: 'Hybrid AI / live-action', hint: 'Real footage transformed or extended by AI' },
	{ key: 'product_advertisement', label: 'Product advertisement', hint: 'Commercial promoting a product or brand' },
	{ key: 'documentary_style', label: 'Documentary-style video', hint: 'Observational / interview / explanatory footage' },
	{ key: 'screen_recording', label: 'Screen recording', hint: 'Captured display output' },
	{ key: 'tutorial', label: 'Tutorial', hint: 'Teaches a process or tool' },
	{ key: 'meme', label: 'Meme', hint: 'Humour/format-driven social clip' },
	{ key: 'unknown', label: 'Unknown', hint: 'Cannot be classified from the evidence given' }
];

export const TECHNIQUES: Term[] = [
	{ key: 'blender_style_3d', label: 'Blender-style 3D animation', hint: 'Look consistent with Blender/Cycles/Eevee-type output (not proof of software)' },
	{ key: 'kinetic_typography', label: 'Kinetic typography', hint: 'Animated text as the main motion element' },
	{ key: 'motion_tracking', label: 'Motion tracking', hint: 'Elements locked to moving footage points' },
	{ key: 'camera_tracking', label: 'Camera tracking', hint: '3D camera solve to place CG in footage' },
	{ key: 'compositing', label: 'Compositing', hint: 'Layers of separately produced elements combined' },
	{ key: 'match_cut', label: 'Match cuts', hint: 'Cuts that match shape/motion/composition across shots' },
	{ key: 'object_replacement', label: 'Object replacement', hint: 'One object swapped for another in-shot' },
	{ key: 'product_swapping', label: 'Product swapping', hint: 'Product variants cycled through the same shot' },
	{ key: 'morphing', label: 'Morphing', hint: 'Continuous transformation between forms' },
	{ key: 'procedural_animation', label: 'Procedural animation', hint: 'Rule/noise-driven motion rather than hand-keyed' },
	{ key: 'physics_simulation', label: 'Physics simulation', hint: 'Cloth/fluid/rigid-body style dynamics' },
	{ key: 'particle_effects', label: 'Particle effects', hint: 'Many small emitted elements' },
	{ key: 'relighting', label: 'Relighting', hint: 'Light changed after capture/render' },
	{ key: 'ai_video_transformation', label: 'AI video transformation', hint: 'Model-driven restyle/transform of video' },
	{ key: 'image_to_video', label: 'Image-to-video generation', hint: 'Still animated by a generative model' },
	{ key: 'video_to_video', label: 'Video-to-video generation', hint: 'Video restyled/re-rendered by a generative model' },
	{ key: 'vfx', label: 'VFX', hint: 'Visual effects integrated with footage' },
	{ key: 'ui_animation', label: 'UI animation', hint: 'Animated interface elements' },
	{ key: 'cgi_integration', label: 'CGI integration', hint: 'CG elements matched into live footage' },
	{ key: 'camera_movement', label: 'Camera movement', hint: 'Notable camera move (dolly, orbit, whip, crane...)' },
	{ key: 'screen_filming', label: 'Screen filming', hint: 'A camera pointed at a display' }
];

export const OBSERVATIONS: Term[] = [
	{ key: 'genjutsu_like_transition', label: 'Genjutsu-like transition', hint: 'Transformation resembling Higgsfield-style effects. Never proof of that product.' },
	{ key: 'ai_film_artefacts', label: 'AI-filmmaking artefacts', hint: 'Warping, identity drift, texture crawl, impossible physics' },
	{ key: 'phone_filmed_display_possible', label: 'Possible phone-filmed display', hint: 'Looks like a handheld camera recording a monitor' },
	{ key: 'monitor_moire', label: 'Monitor moiré', hint: 'Interference patterns typical of filming a screen' },
	{ key: 'rolling_shutter', label: 'Rolling-shutter artefacts', hint: 'Skew/wobble from sensor readout' },
	{ key: 'camera_reflections', label: 'Camera reflections', hint: 'Camera/operator visible in glossy surfaces' },
	{ key: 'raw_3d_preview', label: 'Raw 3D preview render', hint: 'Viewport-like shading, grid, gizmos or low sample noise' },
	{ key: 'untextured_models', label: 'Untextured models', hint: 'Grey/clay shading, placeholder materials' },
	{ key: 'unfinished_render_passes', label: 'Unfinished render passes', hint: 'Visible AOV/pass looks, missing grade or post' },
	{ key: 'final_polished_cgi', label: 'Final polished CGI', hint: 'Finished render with grade, DOF, motion blur' },
	{ key: 'synthetic_camera_motion', label: 'Synthetic camera motion', hint: 'Perfectly smooth/impossible virtual camera path' },
	{ key: 'real_handheld_motion', label: 'Real handheld camera motion', hint: 'Organic shake and parallax from a physical camera' },
	{ key: 'composited_product_shot', label: 'Composited product shot', hint: 'Product plate combined with separate background/FX' }
];

export const RESEARCH_AREAS = [
	'motion_graphics', '3d_production', 'ai_film_techniques', 'product_cinematography', 'vfx', 'editing',
	'camera_movement', 'lighting', 'rendering', 'reproducible_techniques'
] as const;

/** Quick-filter groups used by the dashboard / CLI. */
export const GROUPS: Record<string, { kind: 'category' | 'technique' | 'observation'; keys: string[] }[]> = {
	motionGraphics: [{ kind: 'category', keys: ['motion_graphics', 'motion_graphics_2d', 'motion_graphics_2_5d', 'motion_graphics_3d'] }, { kind: 'technique', keys: ['kinetic_typography', 'ui_animation'] }],
	aiFilm: [{ kind: 'category', keys: ['ai_generated_film', 'hybrid_ai_live_action'] }, { kind: 'technique', keys: ['ai_video_transformation', 'image_to_video', 'video_to_video'] }, { kind: 'observation', keys: ['genjutsu_like_transition', 'ai_film_artefacts'] }],
	threeD: [{ kind: 'category', keys: ['motion_graphics_3d', 'cgi', 'raw_3d_render', 'composited_render'] }, { kind: 'technique', keys: ['blender_style_3d', 'physics_simulation', 'cgi_integration'] }],
	interestingTechnique: [{ kind: 'technique', keys: TECHNIQUES.map((t) => t.key).filter((k) => !['camera_movement'].includes(k)) }]
};

const SETS = {
	category: new Set(CATEGORIES.map((t) => t.key)),
	technique: new Set(TECHNIQUES.map((t) => t.key)),
	observation: new Set(OBSERVATIONS.map((t) => t.key))
};
export const isKnown = (kind: keyof typeof SETS, key: string) => SETS[kind].has(key);
export const allTerms = () => ({ category: CATEGORIES, technique: TECHNIQUES, observation: OBSERVATIONS });
export const termLabel = (kind: string, key: string) => (allTerms() as any)[kind]?.find((t: Term) => t.key === key)?.label ?? key.replace(/^custom:/, '').replace(/_/g, ' ');

// ---------- result schema ---------------------------------------------------------------------------------------

export interface Evidence {
	t?: number | null; // seconds into the video, or null when about the whole clip
	frame?: number | null; // frame index in the supplied set
	note: string;
}
export interface LabelOut {
	key: string;
	confidence: number;
	certainty: 'observed' | 'likely' | 'possible';
	evidence: Evidence[];
}
export interface AnalysisResult {
	schema_version: string;
	summary: string;
	categories: LabelOut[];
	techniques: LabelOut[];
	observations: LabelOut[];
	research: {
		useful: 'useful' | 'not_useful' | 'uncertain';
		relevance: number;
		confidence: number;
		explanation: string;
		relevant_for: string[];
		suggested_methods: string[];
		learnable: string[];
		analyse_further: string[];
	};
	limitations: string;
}

const num = (x: any, d = 0) => (typeof x === 'number' && isFinite(x) ? Math.min(1, Math.max(0, x)) : d);
const str = (x: any) => (typeof x === 'string' ? x.trim() : '');
const strs = (x: any) => (Array.isArray(x) ? x.map(str).filter(Boolean).slice(0, 20) : []);
// Wording that asserts certainty about tools/equipment we can never prove from pixels.
const OVERCLAIM = /(^|_)(confirmed|definitely|certain|proof|exact_pipeline)(_|$)/i;

function labels(kind: 'category' | 'technique' | 'observation', raw: any, problems: string[]): LabelOut[] {
	if (!Array.isArray(raw)) return [];
	const out = new Map<string, LabelOut>();
	for (const r of raw.slice(0, 40)) {
		let key = str(typeof r === 'string' ? r : r?.key).toLowerCase().replace(/[^a-z0-9_:]+/g, '_');
		if (!key) continue;
		if (OVERCLAIM.test(key)) {
			problems.push(`label "${key}" asserts certainty and was rejected; use a "possible"/"-like" observation`);
			continue;
		}
		if (!isKnown(kind, key)) key = `custom:${key.replace(/^custom:/, '')}`;
		const ev: Evidence[] = (Array.isArray(r?.evidence) ? r.evidence : [])
			.slice(0, 8)
			.map((e: any) => ({ t: typeof e?.t === 'number' ? e.t : null, frame: typeof e?.frame === 'number' ? e.frame : null, note: str(e?.note ?? e).slice(0, 400) }))
			.filter((e: Evidence) => e.note);
		const confidence = num(r?.confidence, 0.5);
		const certainty = ['observed', 'likely', 'possible'].includes(r?.certainty) ? r.certainty : confidence >= 0.8 ? 'likely' : 'possible';
		if (!ev.length && confidence > 0.5) problems.push(`label "${key}" has no evidence; confidence capped at 0.5`);
		out.set(key, { key, confidence: ev.length ? confidence : Math.min(confidence, 0.5), certainty: ev.length ? certainty : 'possible', evidence: ev });
	}
	return [...out.values()];
}

/** Normalise whatever an agent returned into AnalysisResult, listing every problem found. Never invents content. */
export function normaliseResult(raw: any): { result: AnalysisResult | null; problems: string[] } {
	const problems: string[] = [];
	if (!raw || typeof raw !== 'object') return { result: null, problems: ['result is not a JSON object'] };
	const rs = raw.research ?? {};
	const useful = ['useful', 'not_useful', 'uncertain'].includes(rs.useful) ? rs.useful : 'uncertain';
	if (!['useful', 'not_useful', 'uncertain'].includes(rs.useful)) problems.push('research.useful missing; set to "uncertain"');
	const result: AnalysisResult = {
		schema_version: TAXONOMY_VERSION,
		summary: str(raw.summary).slice(0, 1500),
		categories: labels('category', raw.categories, problems),
		techniques: labels('technique', raw.techniques, problems),
		observations: labels('observation', raw.observations, problems),
		research: {
			useful,
			relevance: num(rs.relevance, 0),
			confidence: num(rs.confidence, 0),
			explanation: str(rs.explanation).slice(0, 1500),
			relevant_for: strs(rs.relevant_for),
			suggested_methods: strs(rs.suggested_methods),
			learnable: strs(rs.learnable),
			analyse_further: strs(rs.analyse_further)
		},
		limitations: str(raw.limitations).slice(0, 800)
	};
	if (!result.summary) problems.push('summary missing');
	if (!result.categories.length) problems.push('no categories returned');
	if (!result.limitations) problems.push('limitations missing (what the agent could not see)');
	const fatal = !result.summary && !result.categories.length;
	return { result: fatal ? null : result, problems };
}

/** JSON Schema handed to providers that support structured output (kept permissive; normaliseResult is the gate). */
export const RESULT_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['summary', 'categories', 'techniques', 'observations', 'research', 'limitations'],
	properties: {
		summary: { type: 'string' },
		categories: { $ref: '#/$defs/labels' },
		techniques: { $ref: '#/$defs/labels' },
		observations: { $ref: '#/$defs/labels' },
		research: {
			type: 'object',
			additionalProperties: false,
			required: ['useful', 'relevance', 'confidence', 'explanation', 'relevant_for', 'suggested_methods', 'learnable', 'analyse_further'],
			properties: {
				useful: { enum: ['useful', 'not_useful', 'uncertain'] },
				relevance: { type: 'number' },
				confidence: { type: 'number' },
				explanation: { type: 'string' },
				relevant_for: { type: 'array', items: { type: 'string' } },
				suggested_methods: { type: 'array', items: { type: 'string' } },
				learnable: { type: 'array', items: { type: 'string' } },
				analyse_further: { type: 'array', items: { type: 'string' } }
			}
		},
		limitations: { type: 'string' }
	},
	$defs: {
		labels: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['key', 'confidence', 'certainty', 'evidence'],
				properties: {
					key: { type: 'string' },
					confidence: { type: 'number' },
					certainty: { enum: ['observed', 'likely', 'possible'] },
					evidence: {
						type: 'array',
						items: { type: 'object', additionalProperties: false, required: ['t', 'frame', 'note'], properties: { t: { type: ['number', 'null'] }, frame: { type: ['number', 'null'] }, note: { type: 'string' } } }
					}
				}
			}
		}
	}
} as const;
