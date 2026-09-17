# Validation — 2026-09-17

## Automated checks

- `npm test`: **27 passed** on Node 26/macOS ARM64.
- `node wasm_client/verify.mjs`: packaged gzip, WASM and Go runtime hashes match.

The suite uses real DERP, WireGuard and TCP connections to disposable local
fixtures. It covers HTTP, a 17 MiB binary echo with SHA256 equality, both TCP
half-close directions, SSH stdout/stderr and nonzero exit status, rejection of
an incorrect SSH key, host-key rejection before authentication, SFTP binary
round-trip with an encrypted key, interactive PTY, cancellation/deadlines,
concurrent connections, a paused reader, and file-based credential loading.
The map/proxy follow-up additionally checks loading the bundled map with an
unreachable HTTPS proxy, an explicit live-map fetch failing through that proxy,
redaction of proxy credentials/TLS diagnostics, and actual HTTP CONNECT tunnels
for both the map request and DERP WebSocket to the local integration fixture.

## Restricted Linux live validation

The prebuilt artifact and `npm ci --omit=dev` were tested in
`node:22-bookworm-slim`, Node **22.23.2**, Linux ARM64. Image digest:
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.

The container ran as non-root UID 501, with `--cap-drop ALL`,
`--security-opt no-new-privileges`, and [a seccomp rule](test/deny-netlink.json)
denying `socket(AF_NETLINK, ...)` with EPERM. The native
[validation probe](test/netlink-probe.go) confirmed that denial in the same
container before the WASM tool ran. The profile deliberately isolates this
restriction; it is not a replica of every web agent's sandbox policy.

No native `ssh` or `tailcat` was installed. The live test additionally launched
the client with an empty executable search path.
The WASM client connected **directly to public DERP**, without the Worker.
Credentials were mounted read-only from outside the repository.

| Read-only live check | Result | Elapsed |
| --- | --- | --- |
| `hostname; id; uname -a` | n150 responded, exit 0, empty stderr | 3.214 s |
| Separate stdout/stderr, `exit 7` | Exact output and status 7 | 2.807 s |
| Incorrect host fingerprint | Rejected, status 255, no command output | 1.565 s |

These results use the bundled public map, with no `tailcat.dev` bootstrap fetch.
They are individual observations, not performance guarantees. No remote files
or server configuration were changed by these checks. Live SSH is opt-in:

```sh
node wasm_client/test/live.mjs /private/extracted-credentials wr
```

This validates that the JavaScript/WASM route avoids the native Linux netlink
requirement. Outbound HTTPS/WSS access is still required. See the actual
web-agent validation below and [AGENT_PROMPT.md](AGENT_PROMPT.md).

## Slow proxy startup regression

The web-agent sandbox opened its relay WebSocket in about 10 seconds, while
the original Go relay and Tailcat ping deadlines were also 10 seconds. A local
HTTP CONNECT fixture delayed relay startup by 11 seconds: the old artifact
failed, and the client-only deadline overlay passed in 11.307 seconds. The
full 17-test WASM suite passed after rebuilding. Session cancellation and
shorter caller deadlines remain enforced.

## Actual web-agent sandbox validation

The existing ChatGPT conversation was tested through Chrome with the user's
uploaded credential ZIP. Node **24.19.0** verified and ran commit
`bccaf0a1d90a962e313907f036fbd50acb95db18` using a 60-second session timeout
and a 75-second external limit.

- `hostname; id; uname -a`: **exit 0 in 14.45 seconds**; hostname
  `ubuntu-n150-1`, user `wr` (UID 1000).
- Bundled map loaded locally; public relay WebSocket opened successfully.
- Some optional relay probes were aborted, but another returned HTTP 200;
  these probe failures did not prevent SSH.
- Host-key and TLS verification stayed enabled, and existing proxy/CA
  configuration was preserved.
- No native Tailcat, Cloudflare Worker fallback, permission changes, or
  remote-server modifications were used.
- The web agent reported that helpers stopped, extracted credentials were
  removed, and the original uploaded ZIP was preserved.

The earlier sandbox failure was a startup deadline race: the relay tunnel
opened around 10 seconds, matching the original 10-second internal deadlines.
The client-only startup extension resolves the observed failure. This is a
single end-to-end observation, not a guarantee for all outbound proxy policies.

## Local-only migration and deployment retirement

The Go source, module files, DERP fixture, JavaScript bridge, and bridge tests
now live under `wasm_client/`. A clean local build and test run no longer need
Cloudflare tooling or any `worker/` directory. The SSH adapter defaults to the
local WASM SDK; gateway clients, URL flags, deployment scripts, and website
assets are removed. Tests retain the SSH exit-status race check and cover
command/rsync argument parsing alongside the bridge and integration suite.

The rebuilt artifact was tested against n150 on macOS ARM64 with Node 26.8.2
and no native tools on PATH:

| Read-only check | Result | Elapsed |
| --- | --- | --- |
| `hostname; id; uname -a` | `ubuntu-n150-1`, exit 0, empty stderr | 2.706 s |
| Separate output streams, `exit 7` | Exact stdout/stderr, exit 7 | 2.563 s |
| Incorrect host fingerprint | Rejected, exit 255, no command output | 1.460 s |

Extracted credentials were removed and the original private ZIP preserved.
Cloudflare confirmed deletion of `tailcat-ssh-worker`; its former workers.dev
endpoint returned HTTP 404 afterward. No remote SSH server changes were made.
