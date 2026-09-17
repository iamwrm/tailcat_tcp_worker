# Validation — 2026-09-17

## Automated checks

- `npm run test:wasm-client`: **11 passed** on Node 26/macOS ARM64.
- `npm test`: **31 existing Worker/client tests passed**.
- `node wasm_client/verify.mjs`: packaged gzip, WASM and Go runtime hashes match.

The new suite uses real DERP, WireGuard and TCP connections to disposable local
fixtures. It covers HTTP, a 17 MiB binary echo with SHA256 equality, both TCP
half-close directions, SSH stdout/stderr and nonzero exit status, rejection of
an incorrect SSH key, host-key rejection before authentication, SFTP binary
round-trip with an encrypted key, interactive PTY, cancellation/deadlines,
concurrent connections, a paused reader, and file-based credential loading.

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
the client with an empty executable search path and an unusable `TAILCAT_URL`.
The WASM client connected **directly to public DERP**, without the Worker.
Credentials were mounted read-only from outside the repository.

| Read-only live check | Result | Elapsed |
| --- | --- | --- |
| `hostname; id; uname -a` | n150 responded, exit 0, empty stderr | 5.536 s |
| Separate stdout/stderr, `exit 7` | Exact output and status 7 | 3.878 s |
| Incorrect host fingerprint | Rejected, status 255, no command output | 2.408 s |

These are individual observations, not performance guarantees. No remote files
or server configuration were changed by these checks. Live SSH is opt-in:

```sh
node wasm_client/test/live.mjs /private/extracted-credentials wr
```

This validates that the JavaScript/WASM route avoids the native Linux netlink
requirement. The user's web agent still needs a separate test: its outbound
HTTPS/WSS policy may block DERP even though it allowed the Cloudflare Worker.
Use [AGENT_PROMPT.md](AGENT_PROMPT.md) with the existing private ZIP.
