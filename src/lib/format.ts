export function bytes(n: number | null | undefined): string {
	if (n == null) return '—';
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
	return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
export function dur(s: number | null | undefined): string {
	if (s == null) return '—';
	const m = Math.floor(s / 60);
	const sec = Math.round(s % 60);
	return m ? `${m}:${String(sec).padStart(2, '0')}` : `${s.toFixed(1)}s`;
}
export function longDur(s: number | null | undefined): string {
	if (s == null) return '—';
	if (s < 90) return `${Math.round(s)}s`;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}h ${m}m` : `${m}m ${Math.round(s % 60)}s`;
}
export function res(w: number | null, h: number | null): string {
	if (!w || !h) return '—';
	const m = Math.max(w, h);
	return `${w}×${h}${m >= 2160 ? ' · 4K' : m >= 1440 ? ' · QHD' : m >= 1080 ? ' · HD' : ''}`;
}
export function when(iso: string | null | undefined, withTime = true): string {
	if (!iso) return '—';
	const d = new Date(iso);
	if (isNaN(+d)) return '—';
	const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
	return withTime ? `${date}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : date;
}
export function ago(iso: string | null | undefined): string {
	if (!iso) return '—';
	const s = (Date.now() - +new Date(iso)) / 1000;
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
export const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const label = (k: string | null | undefined) => (k ? k.replace(/^custom:/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');
