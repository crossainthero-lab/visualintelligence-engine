export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
	const { json, ...rest } = init ?? {};
	const res = await fetch(path, { ...rest, headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...rest.headers }, body: json !== undefined ? JSON.stringify(json) : rest.body });
	if (!res.ok) {
		let msg = res.statusText;
		try {
			const j = await res.json();
			msg = j.message ?? j.error ?? msg;
		} catch {
			/* not json */
		}
		throw new Error(msg);
	}
	return res.status === 204 ? (undefined as T) : res.json();
}
