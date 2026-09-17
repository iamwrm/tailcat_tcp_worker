# Tailcat TCP gateway on Cloudflare Workers

A TCP gateway with client-provided tools and an optional local WASM client. The stable transport opens
Tailcat connections and forwards raw bytes; SSH, HTTP and other application
protocols run in your local client. New client tools do not require redeploying
the Worker. The Worker exposes only the generic TCP transport and a health check.

**Live:** https://tailcat-ssh-worker.iamwrm.workers.dev

## Local WASM client for restricted sandboxes

[wasm_client/](wasm_client/README.md) runs Tailcat's WebAssembly build locally in
Node.js and connects directly to DERP, bypassing the Worker. No native Tailcat,
OpenSSH, Go installation, root, or Linux netlink is needed to run it. Prebuilt
artifacts are included. It provides a generic TCP SDK and the existing SSH/SFTP
adapter, with credentials read from uploaded files and mandatory host verification.
Direct outbound relay access must be allowed by the sandbox. Start with the
[agent test prompt](wasm_client/AGENT_PROMPT.md).

## Node SSH, file copies and rsync

A local `ssh` or `scp` executable is optional. The Node client implements SSH
using `ssh2`, with mandatory host-key verification and credentials kept local:

```sh
git clone https://github.com/iamwrm/tailcat_tcp_worker.git
cd tailcat_tcp_worker
npm ci --omit=dev
export TAILCAT_ADDR='tc…'
export SSH_USER='your-user'
export SSH_KEY="$HOME/.ssh/id_ed25519"
export SSH_HOST_KEY='SHA256:trusted-server-fingerprint'

node client/ssh.mjs exec -- 'uname -a'
node client/ssh.mjs shell
node client/ssh.mjs upload ./file.txt /tmp/file.txt
node client/ssh.mjs download /tmp/file.txt ./downloaded.txt
rsync -rt -e 'node client/ssh.mjs rsh' ./source/ "$SSH_USER@target:/tmp/destination/"
```

File copies use SFTP. Actual rsync still requires rsync locally and remotely;
the Node helper replaces its SSH transport. These tools use the existing
`/v1/transport` endpoint and need **no Worker redeployment**. See
[client usage](client/README.md) for encrypted keys, recursive copies, exact
path semantics, API use and limitations. For the Worker build/test workflow below,
use full `npm ci` to include development dependencies.

## Native SSH and user-provided tools

Requires Node.js 22.15+ (tested with Node 26) for the dependency-free local adapter.
Download both files into the same directory:

```sh
mkdir -p tailcat-client
cd tailcat-client
curl -fsS -O https://tailcat-ssh-worker.iamwrm.workers.dev/transport.mjs \
          -O https://tailcat-ssh-worker.iamwrm.workers.dev/transport-client.mjs
```

Supply the Tailcat credential, then use your ordinary SSH client:

```sh
export TAILCAT_ADDR='tc…'
ssh -o "ProxyCommand=node $PWD/transport.mjs stdio --port 22" user@your-host
```

This is native interactive SSH: private keys, ssh-agent, passphrase prompts,
host verification, PTY resizing and exit codes are handled by local OpenSSH.
The SSH private key is never sent to the Worker through `/v1/transport`.
Keep the normal trusted `known_hosts` entry for your target.

The same helper supports scp and sftp via their `-o ProxyCommand=…` option, or
any TCP application through a loopback port. For a Tailcat server exposing port 80:

```sh
node transport.mjs forward --listen 127.0.0.1:8080 --port 80
# In another terminal:
curl http://127.0.0.1:8080/hello
```

Use the URL/path appropriate to your target service. For PostgreSQL, choose its
exposed target port (usually 5432), bind a local port such as 15432, and point
your existing database client there. Application credentials stay in that client.
This version admits one active connection per Worker isolate and returns `busy`
for excess connections; database pools needing guaranteed concurrency will need
a later capacity change. There is no automatic replay or resume. Live HTTP, native SSH and a 256 KiB
binary echo passed; a sustained 17 MiB live echo hit the current Free deployment's
CPU limit (the same transfer passes locally). High-throughput use needs more
CPU capacity; no paid-plan change has been made.

`--url` selects a different gateway; `--timeout` selects a total session limit
of 1–3600 seconds (default 1800). `TAILCAT_CLIENT_KEY` is optional for a restricted
Tailcat target. Listening is restricted to loopback. The CLI uses Node's native
WebSocket transport; curl above downloads it.

You can also use the clients directly from a clone, without building the Worker:

```sh
cd client
export TAILCAT_ADDR='tc…'
node transport.mjs forward --listen 127.0.0.1:8080 --port 80
```

### Build your own client tool

Import `openTcp` from `transport-client.mjs`. It is a dependency-free SDK for
Node or browsers (browser calls must satisfy the gateway's same-origin policy):

```js
import { openTcp } from './transport-client.mjs';
const tcp = await openTcp({
  address: process.env.TAILCAT_ADDR,
  port: 80,
});
const receiving = (async () => {
  for await (const chunk of tcp) {
    // Await your application's consumption of these raw Uint8Array bytes.
    console.log(new TextDecoder().decode(chunk));
  }
})();
await tcp.write(new TextEncoder().encode(
  'GET / HTTP/1.1\r\nHost: target\r\nConnection: close\r\n\r\n'
));
tcp.end(); // Half-close upload; continue receiving the response.
await receiving;
await tcp.closed;
```

Your tool owns parsing, credentials, encryption, interactive UI and commands.
The Worker does not execute plugins or interpret SSH/HTTP/database messages on
this endpoint. Any language can implement [TCP transport v1](PROTOCOL.md).
Use SSH or TLS if application content must be encrypted through the Worker.

```text
Your local tool (SSH / curl / database / custom protocol)
       ↕ stdio or loopback TCP
Local adapter / SDK
       ↕ WSS /v1/transport — raw bytes + flow control
Cloudflare Worker → Tailcat / WireGuard over DERP → target TCP service
```

## Target machine

Install [Tailcat](https://github.com/tailscale/tailcat/blob/main/INSTALL.md) on the
machine running your service. Expose its TCP port, for example:

```sh
# HTTP service on localhost:80
tailcat serve 80
# Or, for an existing SSH server on localhost:22:
tailcat serve 22
```

Run the command for the service you want. Keep it running and copy its printed
short `tc…` address into your local client's `TAILCAT_ADDR`. Do not use
`--full-address`. The address includes a WireGuard pre-shared key: treat it as a
credential. Restarting with ephemeral keys changes the address.

Each application handles its own authentication. For SSH, configure the target's
sshd to accept your key and obtain its host fingerprint through a trusted channel:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Supply that fingerprint to the Node client as `SSH_HOST_KEY`, or use native SSH's
trusted `known_hosts`. Both SSH clients authenticate locally; the Worker does
not receive SSH private keys or run an SSH client.

## Build, test, deploy

Requires Node.js 22.15+, npm, and Go (the build automatically selects Go 1.27.1).
Tailcat is pinned to upstream commit `79dc7eff30d78fbe9a2c69c725eb05c82d0d542d`.

```sh
git clone https://github.com/iamwrm/tailcat_tcp_worker.git
cd tailcat_tcp_worker
npm ci
npm run build
npm run check -- --outdir .wrangler/build
npm test
npm run dev
```

Deploy to your own account after changing `name` in `worker/wrangler.jsonc`:

```sh
npx wrangler login
npm run deploy
```

`npm test` starts a temporary loopback DERP relay, a real Tailcat server, and SSH
and SFTP test servers with fresh keys. It exercises the actual Wasm Worker in
Cloudflare's `workerd` runtime. The fixture accepts only fixed synthetic commands;
it never runs client-supplied commands on the development machine.

For live HTTP, native SSH, both TCP half-close directions and a 256 KiB binary echo
through public relays, using fresh fixture credentials:

```sh
node scripts/live-transport-smoke.mjs https://your-worker.workers.dev
```

Set `BINARY_CHUNKS=273` to stress with 17,891,328 bytes. This exceeded the current
Free deployment's CPU limit; the default smoke test stays small. After a platform
termination, the admission lease expires within 15 seconds of its last renewal.

For Node SSH, SFTP, real rsync and PTY/terminal checks against your own server:

```sh
# Set TAILCAT_ADDR, SSH_USER, SSH_KEY and SSH_HOST_KEY first.
python3 scripts/live-node-ssh-smoke.py
```

This harness uses no local SSH executable for client operations. It needs rsync
locally and remotely, and creates/removes its own temporary remote directory.

### Local performance comparison

After building and running the dry-run bundle step above, run:

```sh
node scripts/bench-transport.mjs
# Optional saved baseline bundle and client:
node scripts/bench-transport.mjs /path/to/baseline-bundle /path/to/baseline-client.mjs
```

This POSIX harness uses `ps` to measure local workerd process CPU, including all
runtime threads. It warms up first, runs 12 HTTP and 12 random 256 KiB echo
transfers, verifies their contents, counts frames/credit updates, and measures
100 one-byte round trips. `BENCH_ROUNDS` changes the sample count. It is a local
comparison, not a prediction of Cloudflare's billed CPU or production P50.

## Design and limits

- `/v1/transport` opens one TCP connection per WebSocket. `/api/health` reports
  runtime health and supported protocols; it does not check target connectivity.
- Each connection gets a separate Go/Wasm instance and Tailcat client. The compiled
  module is reused, but credentials and sockets are not. SSH commands, PTYs and
  file transfers belong to client tools, not the Worker.
- The app does not save Tailcat credentials to disk, KV, D1, R2, Durable Objects,
  or browser storage. Request and Go debug logging are disabled. Managed runtimes
  do not promise immediate cryptographic erasure of freed memory.
- Traffic uses DERP relays. There is no direct UDP NAT traversal from the Worker.
- Public requests cannot supply a relay URL or embedded relay address. Operators
  can configure a trusted `DERP_MAP_URL`. `TEST_DERP_HTTP` is only for local tests.
- One active connection runs per Worker isolate. Additional connections receive
  `busy`. The rate limit is approximately 20 new connections/minute per IP per
  Cloudflare location; it is not an account-wide spending cap.
- Session duration defaults to 30 minutes and is capped at one hour. Frames and
  credit windows bound buffering; see [the protocol](PROTOCOL.md). There is no
  automatic reconnect, replay or resume. A disconnect does not guarantee that
  an application operation or remote command has stopped.
- The Free deployment is for light use. Large transfers can exceed its CPU limit
  even if they pass locally. No paid subscription is enabled by this project.
- Tailcat's API and wire format are experimental; public relays are rate limited.

## Source layout

```text
worker/   TCP gateway, Go/Wasm runtime, website, config and integration tests
client/   TCP adapter, portable SDK, Node SSH and file-transfer tools
scripts/  Build tooling, dependency patch and live smoke tests
```

Run npm commands from the repository root. `npm run build` generates the Wasm
and Go runtime in `worker/src/generated/`, then copies client downloads and the
protocol document into `worker/public/`. Generated files are excluded from Git;
edit the originals in `client/` and `PROTOCOL.md`. Pinned dependencies are recorded
in `worker/go.mod`, `worker/go.sum` and root `package-lock.json`.

- `worker/cmd/workerwasm/main.go`: TCP runtime entry point and deadlines.
- `worker/cmd/workerwasm/connector.go`: Tailcat connection setup.
- `worker/cmd/workerwasm/transport.go`: binary TCP bridge and graceful shutdown.
- `worker/src/index.js`: transport routing, origin checks and connection limits.
- `worker/src/transport.js`: WebSocket protocol and runtime lifecycle.
- `worker/src/bridge.js`: bounded frame/credit batching and synchronous Wasm bridge paths.
- `worker/src/runtime.js`: isolated runtime cleanup and admission.
- `client/transport-client.mjs`, `client/transport.mjs`: SDK and local TCP adapter.
- `client/ssh.mjs`, `client/ssh-client.mjs`, `client/sftp.mjs`: client-side SSH,
  SFTP and rsync remote-shell tools.
- `scripts/gonet-drain.go.txt`: TCP shutdown addition applied to a private
  dependency copy during build.
