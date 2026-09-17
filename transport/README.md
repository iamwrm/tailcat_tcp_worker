# Tailcat WASM transport

Run Tailcat's `js/wasm` build inside Node.js, connecting directly to DERP over
WebSockets. The SSH adapter in `apps/` uses `ssh2` locally. No native
Tailcat, OpenSSH, Go installation, root, TUN device, or Linux netlink is needed
to run the tool. This is a Node CLI and SDK; a browser UI is not included.

```text
Node application (SSH, SFTP, or another TCP protocol)
  → local Tailcat WASM in a worker thread
  → WebSocket to DERP → remote Tailcat → target TCP service
```

The public relay map is bundled, so startup does **not** fetch `tailcat.dev`.
The sandbox must allow WSS to the selected DERP server. All transport and SSH
processing runs locally.

HTTPS and relay WebSockets honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`
(and their lowercase forms), using Undici's `EnvHttpProxyAgent`. Proxy
credentials are never printed. TLS verification stays enabled; a sandbox with
an intercepting proxy must supply its trusted CA through its normal Node setup
(for example `NODE_EXTRA_CA_CERTS` set before Node starts).

## Run with uploaded credentials

Requires Node.js **22.15+** and npm. From the repository root:

```sh
npm ci --omit=dev
npm run download
node transport/verify.mjs
node apps/ssh.mjs exec \
  --credentials-dir /private/extracted-credentials \
  --user wr --timeout 60 -- 'hostname; id; uname -a'
```

The directory must contain `id_ed25519`, `tailcat-address.txt`, and
`ssh-host-key.pub`. Extract the uploaded ZIP locally into a private directory
(mode 700), with credential files mode 600. The public host key must come from
a trusted source; it is not fetched from the unverified remote connection.

The CLI reads the Tailcat address directly from its file and derives the SSH
SHA256 fingerprint from the uploaded public host key. Neither secret is placed
in command arguments. Host verification is mandatory, the private SSH key stays
in the local SSH adapter, and the WASM transport receives only Tailcat connection
parameters. No address, private key, or passphrase is logged by the transport.
Remote command output is application-controlled and must be handled accordingly.

Other ways to supply files:

```sh
node apps/ssh.mjs exec \
  --address-file /private/tailcat-address.txt \
  --host-key-file /private/ssh-host-key.pub \
  --key /private/id_ed25519 --user wr -- 'id'
```

Existing `TAILCAT_ADDR`, `SSH_USER`, `SSH_KEY`, `SSH_HOST_KEY`,
`SSH_KEY_PASSPHRASE`, and `TAILCAT_CLIENT_KEY` environment values are supported.
`--client-key-file` supplies an optional Tailcat identity for a server allowlist.
Short Tailcat addresses with a PSK are required; embedded-relay
`--full-address` values are not supported.

## SSH applications

The SSH adapter supports commands, interactive shells, and file transfers:

```sh
node apps/ssh.mjs shell --credentials-dir /private/credentials --user wr
node apps/ssh.mjs upload --credentials-dir /private/credentials --user wr ./file.bin /tmp/file.bin
node apps/ssh.mjs download --credentials-dir /private/credentials --user wr /tmp/file.bin ./file.bin
```

`shell` needs a terminal; Ctrl+] disconnects. Files use SFTP, with `--recursive`
for directory trees. `rsh` is available as an rsync transport; rsync still needs
to be installed locally and remotely. See [the SSH application documentation](../apps/README.md).
`exec` returns the remote exit code; setup or transport failures return 255.
`--timeout` limits the entire transport lifetime, including startup (1–3600
seconds, default 1800). Local startup permits 30 seconds for relay setup and
the Tailcat ping, 40 seconds for TCP dialing, and 45 seconds overall. A shorter
`--timeout` still takes precedence. SIGINT/SIGTERM cancel it and stop the WASM worker thread.

## Generic TCP SDK

SSH is one adapter. Import `openTcp` from `transport/transport-client.mjs`
for other applications. Its contract supports one reader,
sequential awaited writes, bounded 64 KiB windows, 16 KiB frames, TCP half-close,
cancellation, and a `closed` promise. Each connection has its own WASM thread.

```js
import { readFile } from 'node:fs/promises';
import { openTcp } from './transport/transport-client.mjs';
const tcp = await openTcp({
  address: (await readFile('/private/tailcat-address.txt', 'utf8')).trim(),
  port: 80, timeout: 30,
});
const reading = (async () => {
  for await (const bytes of tcp) process.stdout.write(bytes);
})();
await tcp.write(new TextEncoder().encode(
  'GET / HTTP/1.1\r\nHost: target\r\nConnection: close\r\n\r\n'));
tcp.end();
await reading;
await tcp.closed;
```

An optional HTTPS `derpMapURL` selects a different relay map. Plain HTTP relays
are enabled only with the explicit SDK `allowLocalRelayForTests` flag and a
loopback map URL; the CLI does not expose this test mode.

The bundled [derpmap.json](derpmap.json) is a public snapshot retrieved from
`https://tailcat.dev/derpmap.json` on 2026-09-17 (regions 301–304), with no user
credentials. Relay topology can change: `--live-relay-map` opts into fetching
the latest map, or `--derp-map-file FILE` supplies a newer trusted snapshot.
The SDK equivalents are `liveRelayMap: true` and `derpMapFile`.

Errors identify the map-fetch or relay-WebSocket stage and, when available,
a safe error code such as `ECONNREFUSED`, `ENOTFOUND`, or
`SELF_SIGNED_CERT_IN_CHAIN`. They do not expose raw errors or proxy URLs.
Add `--diagnostics` to print safe connection stages to stderr. This shows
whether the map loaded locally, relay HTTPS probe outcomes, and WebSocket
open/failure events. It includes only relay hostnames learned from the public
map, numeric status codes, and proxy/extra-CA presence booleans. It never prints
request paths/queries, proxy URLs, the Tailcat address, or SSH credentials.
Optional relay probes cannot overwrite a map or WebSocket failure in the final
error. For SDK callers, `onDiagnostic(event)` receives the same trace.

## Packaged artifacts and development

`dist/tailcat.wasm.gz` (about 6 MiB) is a versioned GitHub release asset, not Git
content. Run `npm run download` once after installing dependencies; it honors
proxy/CA settings, verifies compressed and uncompressed SHA256 hashes from the
committed `dist/manifest.json`, and atomically installs the file locally. A valid
local artifact is reused without network access. Startup never downloads code.
The matching `dist/go-runtime.js` remains checked in. The manifest is trusted
repository content, not an independent signature. For offline setup, copy the
release asset to `transport/dist/tailcat.wasm.gz` and run `npm run check`.
Rebuilds use `transport/go/cmd/tailcatwasm`, the pinned Go 1.27.1 toolchain and
module graph, and the reviewed TCP shutdown patch.
The build applies two exact-match upstream deadline replacements using a Go
overlay over private dependency copies. The module cache stays unchanged;
the packaged manifest records the local deadlines. See
[third-party notices](../THIRD-PARTY.md) for licenses.

```sh
npm ci
npm run build
npm test
npm run check
```

Building and integration tests require Go. Ordinary use does not. The Node
adapter uses a browser-like Go runtime scope so Go uses Fetch and WebSocket
networking even when hosted by Node on Linux. It never invokes a native Tailcat
binary. See [validation](VALIDATION.md) and [the agent prompt](../prompts/02-web-agent-wasm-ssh.md).

### Publishing a new WASM release

Build and test with the pinned toolchain. Publish `transport/dist/tailcat.wasm.gz`
as an asset on a new versioned GitHub release (never replace an existing version).
Commit the matching `dist/manifest.json` and `dist/go-runtime.js`, and update the
pinned URL in `transport/download.mjs` in the same change. Do not commit the gzip.
Verify a clean checkout with `npm ci`, `npm run download`, `npm run check`, and
`npm test` before publishing the code update. Keep old release assets available
for older checkouts.
