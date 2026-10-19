import { SvelteSet } from 'svelte/reactivity';

// Selection is shared by Library, Sessions and Analysis Studio. Selecting never starts anything.
class Selection {
	uids = new SvelteSet<string>();
	// "all N results of this filter" can be remembered without holding every uid in the UI
	constructor() {
		try {
			const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('vie-selection') : null;
			if (raw) for (const u of JSON.parse(raw)) this.uids.add(u);
		} catch {
			/* ignore */
		}
	}
	private save() {
		try {
			sessionStorage.setItem('vie-selection', JSON.stringify([...this.uids]));
		} catch {
			/* ignore */
		}
	}
	get size() {
		return this.uids.size;
	}
	has = (u: string) => this.uids.has(u);
	toggle(u: string) {
		this.uids.has(u) ? this.uids.delete(u) : this.uids.add(u);
		this.save();
	}
	addMany(us: string[]) {
		us.forEach((u) => this.uids.add(u));
		this.save();
	}
	removeMany(us: string[]) {
		us.forEach((u) => this.uids.delete(u));
		this.save();
	}
	clear() {
		this.uids.clear();
		this.save();
	}
	list = () => [...this.uids];
}
export const selection = new Selection();

class Toasts {
	items = $state<Array<{ id: number; text: string; bad: boolean }>>([]);
	private n = 0;
	push(text: string, bad = false) {
		const id = ++this.n;
		this.items.push({ id, text, bad });
		setTimeout(() => (this.items = this.items.filter((t) => t.id !== id)), bad ? 8000 : 3500);
	}
}
export const toasts = new Toasts();
