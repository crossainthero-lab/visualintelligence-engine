import { json } from '@sveltejs/kit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '#core/mcp/server.ts';

// Remote MCP (Streamable HTTP, stateless). Authentication is enforced in hooks.server.ts: this endpoint is
// unreachable unless VIE_MCP_TOKEN is configured and presented as a bearer token. Write tools are OFF unless
// VIE_MCP_REMOTE_WRITE=1, so a leaked read token can never change data or spend agent quota.
async function handle(request: Request) {
	const server = buildMcpServer({ write: process.env.VIE_MCP_REMOTE_WRITE === '1', transport: 'http' });
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		queueMicrotask(() => void server.close());
	}
}
export const POST = ({ request }) => handle(request);
export const GET = () => json({ error: 'use POST (Streamable HTTP, stateless)' }, { status: 405 });
export const DELETE = () => new Response(null, { status: 405 });
