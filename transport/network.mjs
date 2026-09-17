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
    if (value?.name === 'AbortError') return 'REQUEST_ABORTED';
    if (value?.name === 'TimeoutError') return 'REQUEST_TIMEOUT';
    if (value?.cause) pending.push(value.cause);
    if (Array.isArray(value?.errors)) pending.push(...value.errors.slice(0, 4));
  }
  return 'NETWORK_ERROR';
}

export async function createNetwork({ mapURL = DEFAULT_MAP, mapFile, liveRelayMap = false,
  env = process.env, onFailure = () => {}, onDiagnostic = () => {} } = {}) {
  let mapText;
  const relayHosts = new Set();
  const learnHosts = map => {
    for (const region of Object.values(map?.Regions || {})) {
      for (const node of region.Nodes || []) {
        // Only public hostnames from the relay map can appear in diagnostics.
        if (/^[a-zA-Z0-9.-]+$/.test(node.HostName || '')) relayHosts.add(node.HostName);
      }
    }
  };
  // A custom map URL is fetched normally. The default public map is shipped
  // with the tool; there is no bootstrap request to tailcat.dev.
  if (mapFile || (!liveRelayMap && mapURL === DEFAULT_MAP)) {
    try {
      mapText = await readFile(mapFile || new URL('./derpmap.json', import.meta.url), 'utf8');
      const map = JSON.parse(mapText);
      if (mapText.length > 1024 * 1024 || !map.Regions || !Object.keys(map.Regions).length) throw new Error('Invalid map');
      learnHosts(map);
    } catch { throw new Error('Cannot read a valid relay map file'); }
  }
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY,
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
  });
  const sockets = new Set();
  let closing = false;
  const stageFor = url => {
    if (String(url) === mapURL) return 'relay_map';
    try {
      if (['/derp/probe', '/derp/latency-check'].includes(new URL(url).pathname)) return 'relay_probe';
    } catch {}
    return 'https_request';
  };
  const targetFor = url => {
    try { const host = new URL(url).hostname; if (relayHosts.has(host)) return host; } catch {}
    return undefined;
  };
  const labels = { relay_map: 'Relay map fetch', relay_probe: 'Relay HTTPS probe', https_request: 'HTTPS request' };
  const diagnostic = event => { if (!closing) onDiagnostic(event); };
  onDiagnostic({ stage: 'network_config', map: mapText === undefined ? 'network' : mapFile ? 'file' : 'bundled',
    proxy_configured: Boolean(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY),
    extra_ca_configured: Boolean(env.NODE_EXTRA_CA_CERTS) });
  return {
    async fetch(url, options = {}) {
      const stage = stageFor(url), target = targetFor(url);
      if (mapText !== undefined && stage === 'relay_map') {
        diagnostic({ stage, result: 'loaded_locally' });
        return new Response(mapText, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      diagnostic({ stage, target, result: 'connecting' });
      try {
        const result = await fetch(url, { ...options, dispatcher });
        diagnostic({ stage, target, result: 'response', status: result.status });
        if (!result.ok) onFailure(`${labels[stage]} failed (HTTP ${result.status}); check outbound HTTPS/proxy policy`, { stage });
        // Map data is public; learn only hostnames for later redacted traces.
        if (result.ok && stage === 'relay_map') {
          try { learnHosts(await result.clone().json()); } catch {}
        }
        return result;
      } catch (error) {
        const code = networkCode(error);
        const message = `${labels[stage]} failed (${code}); check outbound HTTPS, proxy configuration, and trusted CA certificates`;
        diagnostic({ stage, target, result: 'failed', code });
        if (!closing) onFailure(message, { stage });
        throw new Error(message);
      }
    },
    WebSocket: class {
      constructor(url, protocols) {
        const target = targetFor(url);
        diagnostic({ stage: 'relay_websocket', target, result: 'connecting' });
        const ws = new WebSocket(url, { protocols, dispatcher });
        sockets.add(ws); ws.addEventListener('close', () => sockets.delete(ws));
        ws.addEventListener('open', () => diagnostic({ stage: 'relay_websocket', target, result: 'open' }));
        ws.addEventListener('close', event => diagnostic({ stage: 'relay_websocket', target, result: 'closed', close_code: event.code }));
        ws.addEventListener('error', event => {
          const code = networkCode(event.error);
          diagnostic({ stage: 'relay_websocket', target, result: 'failed', code });
          if (!closing) onFailure(`DERP WebSocket connection failed (${code}); check outbound relay/proxy access`, { stage: 'relay_websocket' });
        });
        return ws;
      }
    },
    async close() {
      closing = true;
      for (const ws of sockets) { try { ws.close(); } catch {} }
      sockets.clear(); await dispatcher.destroy();
    },
  };
}
