# Use the ZIP in a web agent

Upload the private ZIP and provide its target hostname and SSH username.
Paste this prompt, changing the port or read-only command if needed.

```text
Use the uploaded credential ZIP to SSH using local Tailcat WASM.
Repository: https://github.com/iamwrm/tailcat_wasm
Intended hostname or SSH alias: <HOSTNAME>
SSH username: <USERNAME>
SSH destination port: <PORT, default 22>
Ask me for any missing hostname or username; never guess or use placeholders.
The hostname identifies my intended target; the ZIP's Tailcat address routes
traffic and its SSH host key verifies identity. Do not resolve or connect
straight to the hostname, and do not invent a --host option for this CLI.

1. Clone the repository or update to latest main. Use Node.js 22.15+.
   From the repository root, run npm ci --omit=dev and npm run check.
   Use the packaged WASM; no Go build or native ssh/tailcat is required.

2. Read the uploaded ZIP locally. Require exactly three root files:
   id_ed25519, tailcat-address.txt, ssh-host-key.pub. Reject unexpected paths,
   symlinks, or duplicate entries. Extract into a private temporary directory
   (700), with files mode 600. Never print credentials, embed their values in
   tool calls, or enable shell tracing. Keep secrets outside the repository.

3. Substitute my username, port, and extraction path safely:
   node apps/ssh.mjs exec --credentials-dir PRIVATE_DIR \
     --user USERNAME --port PORT --timeout 60 -- 'hostname; id; uname -a'
   Enforce a 75-second external timeout and stop the child on timeout.

4. Keep SSH host-key and TLS verification enabled. Use the bundled relay map
   and existing proxy/trusted-CA settings. Do not alter sandbox permissions,
   install native Tailcat, use a hosted gateway, or modify the remote server.

5. If setup fails, retry once with --diagnostics and the same time limits.
   Report the failing stage and sanitized codes, never proxy credentials,
   the Tailcat address, or the private key. Do not bypass a host-key mismatch.

6. Report the supplied hostname/username/port, actual remote hostname,
   Node version, repository commit, elapsed time, exit status, and sanitized
   stdout/stderr. Hostnames may differ for aliases; report discrepancies.
   Distinguish transport failure from a remote command's nonzero status;
   do not claim successful command execution without exit 0.

7. Always stop helper processes and remove extracted credential copies.
   Preserve the original ZIP. Do not revoke or modify keys.
```
