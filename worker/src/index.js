import { transportWebSocket } from './transport.js';

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function error(status, message) {
  return Response.json({ error: message }, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, transport: 'tailcat-wasm-derp', authentication: 'caller-provided-tailcat-credentials', protocols: ['tcp-v1'] }, { headers });
    }
    if (url.pathname !== '/v1/transport') {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return error(404, 'Not found');
      return env.ASSETS.fetch(request);
    }
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return error(405, 'Use a WebSocket upgrade');
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return error(403, 'Cross-origin requests are not accepted');
    if (env.CONNECTION_LIMIT && !(await env.CONNECTION_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) {
      return new Response('Too many requests; retry in a minute', { status: 429, headers: { ...headers, 'Retry-After': '60' } });
    }
    return transportWebSocket(request, env, ctx);
  },
};
