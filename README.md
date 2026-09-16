# Tailcat TCP gateway on Cloudflare Workers

A Worker-only TCP gateway with client-provided tools. The stable transport opens
Tailcat connections and forwards raw bytes; SSH, HTTP and other application
protocols run in your local client. New client tools do not require redeploying
the Worker. The original managed SSH command and curl shell endpoints remain.

**Live:** https://tailcat-ssh-worker.iamwrm.workers.dev

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
CPU capacity; no paid-plan change has been made. The legacy HTTP `/api/exec` smoke test also
hit the CPU ceiling (Cloudflare error 1102); use native SSH over the new transport
for the tested command path.

`--url` selects a different gateway; `--timeout` selects a total session limit
of 1–3600 seconds (default 1800). `TAILCAT_CLIENT_KEY` is optional for a restricted
Tailcat target. Listening is restricted to loopback. The CLI uses Node's native
WebSocket transport; curl above downloads it. The older curl-networking SSH
wrapper is documented below and remains available.

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

## Legacy managed SSH endpoints

The sections below describe `/api/exec` and `/api/shell`, where the Worker itself
performs SSH. Those endpoints still receive caller-provided SSH keys in memory.

## Target machine

Install a current version of [Tailcat](https://github.com/tailscale/tailcat/blob/main/INSTALL.md).
Your existing sshd must accept your SSH key for the selected username.

```sh
# Forward Tailcat port 22 to localhost:22, where sshd is already listening.
tailcat serve 22
```

Keep that process running and privately copy its printed `tc…` address. Use the
ordinary short address, without `--full-address`. Restarting with ephemeral keys
changes the address. The address includes a WireGuard pre-shared key: treat it
as a credential. This does not use Tailcat's built-in SSH server.

Get the SSH server's **Ed25519 host-key fingerprint** on the target:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Copy the `SHA256:…` field. It is a public identity check, not another secret.
This prototype negotiates an Ed25519 **host** key; the user's authentication key
can be any private-key type supported by Go's SSH library.

## Call it with curl

Set `TAILCAT_ADDR` to your secret `tc…` address and `SSH_HOST_KEY` to the fingerprint.
Change `deploy` and the private-key path to your actual SSH username and key.

```sh
curl --no-buffer --fail-with-body \
  'https://tailcat-ssh-worker.iamwrm.workers.dev/api/exec' \
  -H 'Accept: text/plain' \
  --form-string "tailcat_address=$TAILCAT_ADDR" \
  --form-string 'username=deploy' \
  -F "private_key=@$HOME/.ssh/id_ed25519" \
  --form-string "host_key_sha256=$SSH_HOST_KEY" \
  --form-string 'command=uname -a && uptime'
```

This works with ordinary HTTP curl builds; curl itself does not run SSH or
Tailcat. `-F private_key=@…` sends the contents of the key file. For an encrypted
private key, also supply a `passphrase` field. All credentials travel in the HTTPS
request body, never in the URL. The gateway can see and use them while connecting.

The plain response combines stdout and stderr. It adds `[exit N]` for nonzero
remote exits, or an error line if execution fails. **curl's own exit code does
not represent the remote command's exit code.**

Omit the `Accept: text/plain` header to receive newline-delimited JSON instead:

```json
{"stage":"connecting","type":"status"}
{"stage":"running","type":"status"}
{"data":"aGVsbG8K","encoding":"base64","type":"stdout"}
{"code":0,"type":"exit"}
```

`stdout` and `stderr` events carry base64 bytes to preserve arbitrary output and
UTF-8 split across chunks. An `exit` event is the remote exit status. An `error`
event means execution failed or was interrupted. A dropped stream without either
event is incomplete. Metrics can follow the terminal event in this prototype.
Once streaming starts, HTTP 200 does not imply that SSH or the command succeeded.

## Interactive shell in your local terminal

The interactive client uses **curl for all network traffic**, plus a small
Python 3 standard-library wrapper for WebSocket framing, terminal modes, and
resize events. No pip packages, SSH proxy helper, or browser terminal are needed.
A bare curl invocation cannot configure a terminal or frame WebSocket messages.

Set `TAILCAT_ADDR` and `SSH_HOST_KEY`, then run this on macOS or Linux:

```sh
export TAILCAT_ADDR='tc…'
export SSH_HOST_KEY='SHA256:…'

curl --fail --silent --show-error \
  https://tailcat-ssh-worker.iamwrm.workers.dev/shell.py | \
  python3 - --user deploy --key "$HOME/.ssh/id_ed25519"
```

Or download `shell.py`, inspect it, and run it with the same arguments. Add
`--ask-passphrase` to prompt locally for an encrypted SSH key's passphrase.
`--host-key` overrides `SSH_HOST_KEY`; `--url` selects your own Worker origin.
An optional `TAILCAT_CLIENT_KEY` supplies a restricted Tailcat client identity.

The session opens an SSH PTY and login shell. It supports arrow keys, Ctrl+C,
Ctrl+D, `top`, `vim`, `sudo` prompts, and window resizing. Type `exit` or press
**Ctrl+]** to disconnect locally. Local terminal settings are restored on exit,
errors, and handled termination signals. The wrapper returns the remote shell's
exit code; an interrupted connection without an exit status is an error.

Credentials are sent once per interactive connection, in its first encrypted
WebSocket message. There are no website accounts or gateway API tokens. The
Worker still receives the private key in memory and performs SSH authentication;
this is not an end-to-end native SSH proxy.

Default session limit: **30 minutes**; `--timeout 3600` allows up to one hour.
Limits also include 4 MiB of input and 16 MiB of output per session. A deployment
or platform runtime restart can interrupt the connection. There is no resume;
use a remote terminal multiplexer if you need persistent remote sessions.

### Interactive protocol

`GET /api/shell` with a WebSocket Upgrade opens a connection. The first text
message is a JSON object with the same credential fields as `/api/exec`, **without
`command`**. Optional `rows`, `cols`, and `term` describe the terminal; sizes must
be 1–1000. Subsequent messages are:

```json
{"type":"input","data":"bHMNCg=="}
{"type":"resize","rows":40,"cols":120}
{"type":"ack","bytes":53}
```

Input is base64 encoded, up to 16 KiB decoded per frame. The server sends the same
NDJSON events used by `/api/exec`, with terminal output in base64. Acknowledge the
UTF-8 byte length of each received WebSocket **message**, including its trailing
newline. Output pauses when at least 64 KiB is unacknowledged; clients that stop
acknowledging for 30 seconds are disconnected. Send the credential message within
10 seconds. Maximum credential line: 256 KiB. Same-origin checks also apply.

The curl wrapper performs a validated HTTP/1.1 WebSocket Upgrade, masks client
frames, and checks `Sec-WebSocket-Accept` before sending credentials. Do not add
`--max-time` to its underlying curl command: older curl versions block stdin
while waiting for that timer. The wrapper and Worker enforce timeouts themselves.
The HTTPS endpoint is used directly, without redirects or TLS bypasses.

A direct streaming `POST /api/shell` protocol is also covered by local tests,
but **use WebSockets on the deployed Worker**: the deployed HTTP ingress path
buffered ongoing POST uploads during testing. The public client selects the
working WebSocket transport automatically.

## Request fields

Accepts multipart form data, URL-encoded form data, or a JSON object.

| Field | Required | Description |
| --- | --- | --- |
| `tailcat_address` | Yes | Current short `tc…` address, including its pre-shared key |
| `username` | Yes | Username authenticated by the target's sshd |
| `private_key` | Yes | Contents of an OpenSSH/PEM private key; upload a file with curl |
| `host_key_sha256` | Yes | Trusted SHA256 fingerprint of the target's Ed25519 host key |
| `command` | Yes | Command string executed by the remote SSH account's shell |
| `passphrase` | No | Passphrase for an encrypted private key |
| `port` | No | Forwarded port, default `22` |
| `timeout_seconds` | No | Total connection/command deadline, default `30`, maximum `120` |
| `tailcat_client_key` | No | `privkey:…` client node identity if the Tailcat server uses `--allow`; not the server's saved private-key file |

The Tailcat address is sufficient for the ordinary `tailcat serve 22` setup.
The optional client identity is only for targets that additionally restrict
Tailcat clients by node public key.

`GET /api/health` is a basic runtime health check; it does not check target connectivity.

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

`npm test` starts a temporary loopback DERP relay, a real Tailcat server, and an
SSH protocol server with fresh test keys. It exercises the actual Wasm Worker in
Cloudflare's `workerd` runtime. The fixture accepts only fixed synthetic commands;
it never runs client-supplied commands on the development machine.

To exercise a deployed Worker using real curl and a public DERP relay:

```sh
node scripts/live-smoke.mjs https://your-worker.workers.dev
```

For the generic transport, native SSH, HTTP, both half-close directions and a
256 KiB binary echo through public relays:

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

For interactive curl, PTY input, resizing, Ctrl+C, and a 35-second idle interval:

```sh
python3 scripts/live-shell-smoke.py
```

These tests create ephemeral credentials and close the test server afterward.
It does not read or use your personal SSH keys.

## Design and limits

```text
curl / browser → HTTPS Worker → Go Wasm SSH client
                                 ↓
                    Tailcat / WireGuard over DERP WebSocket
                                 ↓
                       target Tailcat → localhost:sshd
```

- Each connection gets a separate Go/Wasm instance, Tailcat client, and SSH session.
  The compiled Wasm module is reused, but credentials and sockets are not.
- The app does not save credentials to disk, KV, D1, R2, Durable Objects, or browser
  storage. Request and Go debug logging are disabled. Managed runtimes do not
  promise immediate cryptographic erasure of freed memory.
- Every SSH connection verifies the supplied host-key fingerprint before user
  authentication. The remote sshd makes the authentication/authorization decision.
- Traffic uses DERP relays. There is no direct UDP NAT traversal from the Worker.
- Public requests cannot supply a relay URL or embedded relay address. The
  operator can configure a trusted `DERP_MAP_URL` binding for their own relay map.
  `TEST_DERP_HTTP` is for the local test harness only; leave it unset in deployments.
- `/api/exec` runs individual commands; `/api/shell` provides an interactive PTY.
  There is no file transfer API, job queue, or reconnect/resume. Closing a connection
  or hitting a deadline does not guarantee
  a remote process has stopped. Do not automatically retry a command whose outcome
  is unknown.
- Command limits: 256 KiB request body, 16 KiB command, 1 MiB output, 120-second
  maximum deadline. Interactive limits are described above. One active session
  runs per Worker isolate (excess requests receive 503 or a WebSocket error).
  The deployed rate-limit binding allows approximately 20 requests/minute per IP
  per Cloudflare location; it is not an account-wide spending cap.
- The live smoke test succeeded on the current Free plan. Free Workers have a
  small CPU allowance; heavier keys, encryption, or output may exceed it. Local
  `workerd` tests do not prove every workload fits the deployed plan's CPU limits.
  No paid subscription is enabled by this project.
- Tailcat's API and wire format are experimental; its public relays are rate limited.

See [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/),
and [Tailcat](https://github.com/tailscale/tailcat).

## Source layout

```text
worker/   Worker API, Go/Wasm implementation, website, config and integration tests
client/   Local TCP adapter, portable SDK and legacy curl terminal wrapper
scripts/  Build tooling, dependency patch and live smoke tests
```

Run npm commands from the repository root. `npm run build` generates the Wasm
and Go runtime in `worker/src/generated/`, then copies client downloads and the
protocol document into `worker/public/`. Generated files are excluded from Git;
edit the originals in `client/` and `PROTOCOL.md`. Go module files live in
`worker/`. The pinned dependencies are recorded in `worker/go.mod`,
`worker/go.sum` and root `package-lock.json`.

- `worker/cmd/workerwasm/connector.go`: shared Tailcat connector.
- `worker/cmd/workerwasm/transport.go`: binary TCP bridge and graceful shutdown.
- `worker/cmd/workerwasm/main.go`: legacy SSH adapter, host-key pinning and deadlines.
- `worker/src/transport.js`: versioned WebSocket protocol and bidirectional flow control.
- `worker/src/runtime.js`: shared isolated runtime cleanup and admission.
- `client/transport-client.mjs`, `client/transport.mjs`: user-side SDK and local adapter.
- `scripts/gonet-drain.go.txt`: minimal TCP shutdown addition, applied to a private dependency copy during build.
- `worker/src/index.js`: HTTP API, bounded input, streaming response, per-request runtime cleanup.
- `worker/src/shell.js`, `worker/src/shell-websocket.js`: interactive input, framing, and flow control.
- `client/ssh.mjs`, `client/ssh-client.mjs`, `client/sftp.mjs`: Node SSH, SFTP and rsync remote-shell tools.
- `client/shell.py`: macOS/Linux terminal wrapper using curl as its transport.
- `scripts/build.mjs`: Wasm compilation and scoped Go runtime adapter; no `eval`.
- `worker/public/`: Website; no third-party scripts or external assets.
- `worker/test/`: Real protocol integration tests.

The build copies the Go runtime with its license in `GO-LICENSE`. Tailcat and its
dependencies retain their respective upstream licenses; see `THIRD-PARTY.md`.
