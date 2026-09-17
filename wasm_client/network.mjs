import { readFile } from 'node:fs/promises';
import { fetch, WebSocket, EnvHttpProxyAgent } from 'undici';

export const DEFAULT_MAP = 'https://tailcat.dev/derpmap.json';

// Error messages/URLs can contain proxy credentials. Export only known codes.
export function networkCode(error) {
  const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
  const pending = [error];
  for (let i = 0; i < pending.length && i < 12; i++) {
    const value = pending[i];
    if (allowed.has(value?.code)) return value.code;
    if (value?.cause) pending.push(value.cause);
    if (Array.isArray(value?.errors)) pending.push(...value.errors.slice(0, 4));
  }
  return 'NETWORK_ERROR';
}

export async function createNetwork({ mapURL = DEFAULT_MAP, mapFile, liveRelayMap = false,
  env = process.env, onFailure = () => {} } = {}) {
  let mapText;
  // A custom map URL is fetched normally. The default public map is shipped
  // with the tool; there is no bootstrap request to tailcat.dev.
  if (mapFile || (!liveRelayMap && mapURL === DEFAULT_MAP)) {
    try {
      mapText = await readFile(mapFile || new URL('./derpmap.json', import.meta.url), 'utf8');
      const map = JSON.parse(mapText);
      if (mapText.length > 1024 * 1024 || !map.Regions || !Object.keys(map.Regions).length) throw new Error('Invalid map');
    } catch { throw new Error('Cannot read a valid relay map file'); }
  }
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY,
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
  });
  const sockets = new Set();
  return {
    async fetch(url, options = {}) {
      if (mapText !== undefined && String(url) === mapURL) return new Response(mapText, { status: 200, headers: { 'Content-Type': 'application/json' } });
      try {
        const result = await fetch(url, { ...options, dispatcher });
        if (!result.ok) onFailure(`Relay map fetch failed (HTTP ${result.status}); check outbound HTTPS/proxy policy`);
        return result;
      } catch (error) {
        const message = `Relay map fetch failed (${networkCode(error)}); check outbound HTTPS, proxy configuration, and trusted CA certificates`;
        onFailure(message); throw new Error(message);
      }
    },
    WebSocket: class {
      constructor(url, protocols) {
        const ws = new WebSocket(url, { protocols, dispatcher });
        sockets.add(ws); ws.addEventListener('close', () => sockets.delete(ws));
        ws.addEventListener('error', event => {
          onFailure(`DERP WebSocket connection failed (${networkCode(event.error)}); check outbound relay/proxy access`);
        });
        return ws;
      }
    },
    async close() {
      for (const ws of sockets) { try { ws.close(); } catch {} }
      sockets.clear(); await dispatcher.destroy();
    },
  };
}
