import type { Profile, ProfileId } from './types.ts';

export const PROFILES: Record<ProfileId, Profile> = {
	index: {
		id: 'index', level: 0, label: 'Level 0 · Index only', usesProvider: false,
		description: 'No AI. ffprobe facts, hashes, thumbnails, source information. Never counts as analysed.',
		frames: 0, frameWidth: 0, contactSheet: false, shots: false, perShotFrames: 0, burstFrames: 0, timeoutS: 60
	},
	quick: {
		id: 'quick', level: 1, label: 'Level 1 · Quick triage', usesProvider: true,
		description: 'Sparse representative frames + metadata. Likely categories and whether deeper inspection is worthwhile.',
		frames: 6, frameWidth: 640, contactSheet: false, shots: false, perShotFrames: 0, burstFrames: 0, timeoutS: 300
	},
	standard: {
		id: 'standard', level: 2, label: 'Level 2 · Standard analysis', usesProvider: true,
		description: 'More frames, detected shot structure, contact sheet. Structured labels, descriptions and evidence.',
		frames: 14, frameWidth: 768, contactSheet: true, shots: true, perShotFrames: 0, burstFrames: 0, timeoutS: 420
	},
	deep: {
		id: 'deep', level: 3, label: 'Level 3 · Deep production research', usesProvider: true,
		description: 'Shot-by-shot frames, a short burst around the strongest cut, plausible production workflow and reproduction ideas (always inference, never proof).',
		frames: 18, frameWidth: 1024, contactSheet: true, shots: true, perShotFrames: 10, burstFrames: 4, timeoutS: 600
	}
};

export const profileList = () => Object.values(PROFILES);
export const getProfile = (id: string): Profile => {
	const p = PROFILES[id as ProfileId];
	if (!p) throw new Error(`unknown profile "${id}" (use ${Object.keys(PROFILES).join(', ')})`);
	return p;
};
