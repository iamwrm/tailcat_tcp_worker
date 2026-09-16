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

The 28 integration cases cover legacy SSH exec and PTY operation, authentication
and host-key rejection, Unicode, resize and Ctrl+C, deadlines and cleanup, binary
TCP (17,891,328-byte echo with matching hash), both TCP half-close directions,
flow-control limits, malformed messages, native OpenSSH, local HTTP forwarding,
and admission reservation while a connection is idle.

Half-close testing caught a shutdown race: destroying the network stack immediately
after CloseWrite could discard queued bytes. The build adds the reviewed method
in `scripts/gonet-drain.go.txt` to a private copy of pinned gVisor so shutdown waits
for TCP acknowledgement. The shared Go module cache remains unchanged.

## Deployment observations

Live tests passed for native OpenSSH with host verification and a real remote PTY,
HTTP, both half-close directions, a 256 KiB binary echo, and the legacy curl shell
with resizing, Ctrl+C and 35 seconds idle followed by more input. Temporary SSH
authorizations used for the real-host test were removed afterward.

A sustained 17 MiB transfer exceeded the Free deployment's CPU limit. A legacy
HTTP `/api/exec` check also returned Cloudflare error 1102 (CPU limit). These routes
pass locally, but local success does not establish production CPU capacity.
Native SSH over `/v1/transport` is the live-tested command path. This is a light-use
prototype, with one active runtime per Worker isolate, not a throughput or
concurrency guarantee. No paid-plan change was made.

See the live smoke scripts in `scripts/` and protocol details in `PROTOCOL.md`.
