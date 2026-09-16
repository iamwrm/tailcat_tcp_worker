# Verification

The implementation was exercised in Cloudflare's local workerd runtime and on a
Cloudflare Workers Free deployment. Tests use generated SSH keys and synthetic
protocol services; the fixture never runs client-supplied OS commands.

## Local checks

```sh
npm ci
npm run build
npm run check -- --outdir .wrangler/build
npm test
```

The 31 tests cover batching and cancellation boundaries, SDK credit ownership,
SSH exit delivery within one parser turn, TCP-only health reporting, rejection of removed
managed SSH routes, binary TCP (17,891,328-byte echo with matching hash), both
TCP half-close directions, flow-control limits, malformed messages, deadlines,
native OpenSSH, local HTTP forwarding, admission reservation during idle
connections, Node SSH with separate stdout/stderr and exit status, binary
backpressure, host verification before authentication, PTY resizing and Ctrl+C,
encrypted keys, SFTP file/tree copies and cleanup, and Node exec/rsync adapters
with no SSH executable on PATH.

Half-close testing caught a shutdown race: destroying the network stack immediately
after CloseWrite could discard queued bytes. The build adds the reviewed method
in `scripts/gonet-drain.go.txt` to a private copy of pinned gVisor so shutdown waits
for TCP acknowledgement. The shared Go module cache remains unchanged.

## Node-only client live verification

The client tools were previously tested through the generic TCP gateway against a
real Ubuntu OpenSSH server. Adding those tools needed no Worker redeployment. Test processes used
a PATH without `ssh` or `scp`; Node and rsync were invoked by absolute path.

- Executed a command, preserved separate stdout/stderr, and returned exit code 7.
- Rejected a mismatched host key.
- Used an encrypted temporary SSH key, including a hidden terminal passphrase
  prompt; the passphrase was checked not to appear in captured terminal output.
- Round-tripped 20,003 random bytes using SFTP and checked exact contents.
- Atomically replaced an existing remote file with an empty file; verified the
  result by downloading over an existing local file.
- Recursively copied a directory containing a Unicode filename in both directions.
- Opened a real PTY, resized 30×90 to 42×111, used Ctrl+C and arrow history,
  returned exit code 7, disconnected with Ctrl+], and checked local terminal
  flags were restored after both sessions.
- Used actual rsync over the Node remote-shell adapter to upload and download a
  directory. A second upload transferred only the changed file; the downloaded
  result matched its SHA256 and the unchanged file remained intact.
- Removed the remote temporary directory and generated SSH key authorization;
  restored the original authorized_keys exactly. No existing personal SSH key
  was uploaded to the Worker.

To reproduce with your own credentials and an SSH server with SFTP and rsync:

```sh
# Set TAILCAT_ADDR, SSH_USER, SSH_KEY and SSH_HOST_KEY first.
# Set SSH_KEY_PASSPHRASE if the key is encrypted.
python3 scripts/live-node-ssh-smoke.py
```

The live harness needs POSIX Python, Node and rsync. It creates a temporary
remote /tmp directory and cleans it up. It does not configure authorization or
read existing personal SSH keys itself; the Node client reads the key you select.

## Deployment observations

After removing Worker-managed SSH on 2026-09-16, all 19 local tests passed.
Deployment `4e10429a-6013-4c36-9f36-55801f82388d` passed the live HTTP, native
SSH, client/server half-close and 262,144-byte binary echo checks. SHA256 matched
for the echoed bytes. Removed endpoints return 404 for GET, POST and WebSocket
Upgrade requests; the removed browser form, styles, script and Python download
also return 404. Health advertises only `tcp-v1`.

Live tests passed for native OpenSSH with host verification and a real remote PTY,
HTTP, both half-close directions, and a 256 KiB binary echo. Temporary SSH
authorizations used for the real-host test were removed afterward.

A sustained 17 MiB transfer exceeded the Free deployment's CPU limit. The same
transfer passes locally, but local success does not establish production CPU capacity.
Native SSH and the Node SSH client over `/v1/transport` are live-tested command paths. This is a light-use
prototype, with one active runtime per Worker isolate, not a throughput or
concurrency guarantee. No paid-plan change was made.

See the live smoke scripts in `scripts/` and protocol details in `PROTOCOL.md`.

## TCP batching and bridge optimization

Local comparison on 2026-09-17 (macOS, 12 warm trials per workload; `ps` CPU
accounting for the whole workerd process, not production Worker CPU):

| Workload / metric | Before | After |
| --- | ---: | ---: |
| 256 KiB echo: mean process CPU | 125.0 ms | 101.7 ms |
| 256 KiB echo: median completion | 95.5 ms | 77.5 ms |
| 256 KiB echo: median output frames | 69 | 18 |
| 256 KiB echo: median upload credit messages | 16 | 8 |
| 256 KiB echo: median download credit messages | 69 | 14 |
| Small HTTP: mean process CPU | 38.3 ms | 40.0 ms |
| One-byte echo: median round trip | 0.456 ms | 0.433 ms |

The bulk workload used about 19% less local process CPU in this comparison;
small-request CPU did not improve. An earlier pair measured about 12% lower
bulk CPU. These measurements have normal run-to-run variation and do not establish
a new Cloudflare P50. See the saved [benchmark results](worker/test/benchmarks/tcp-batching.json)
and `scripts/bench-transport.mjs` to reproduce the workloads.

Frame coalescing preserves the v1 frame/credit limits. Tiny replies bypass the
batching timer, and FIN flushes buffered bytes first. Ready Wasm reads/writes
avoid Promise callbacks; fixed data buffers are reused. Credit messages batch
consumed bytes only, and output stall timers update their deadline without
being recreated on each acknowledgement.

All 31 local tests pass, including a 17 MiB transfer with matching SHA256, both
half-close directions, stalled consumers, malformed credit, cancelled operations,
SSH host verification, interactive PTY resizing/Ctrl+C, SFTP and rsync adapters.
The Node SSH adapter now attaches channel listeners synchronously, preventing
lost exit events when several SSH packets arrive in one coalesced TCP chunk.
Update the local Node client along with the SDK to get that fix and ACK batching.

Deployment `a21bbd54-685e-46f0-8ba5-3cc0ec9de44d` passed live HTTP,
both TCP half-close checks, native SSH, Node SSH (separate output and exit 7),
and a 256 KiB binary echo with matching SHA256. The updated SDK and protocol
assets were verified byte-for-byte against the deployed downloads.
