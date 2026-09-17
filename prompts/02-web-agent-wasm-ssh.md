# Use the ZIP in a web agent

Upload the private ZIP, then paste this prompt. Edit the username, port, or
read-only command if your target differs.

```text
Use the uploaded credential ZIP to SSH from your Linux sandbox using
local Tailcat WASM. Repository: https://github.com/iamwrm/tailcat_wasm
SSH username: wr; destination port: 22.

1. Clone the repository, or update an existing checkout to latest main.
   Use Node.js 22.15 or newer. From the repository root, run:
   npm ci --omit=dev
   npm run check
   Use the packaged WASM; no Go build or native ssh/tailcat is required.

2. Read the uploaded ZIP locally. It must contain exactly these three
   root files: id_ed25519, tailcat-address.txt, ssh-host-key.pub.
   Reject unexpected paths, symlinks, or duplicate entries. Extract into
   a private temporary directory (700), with files mode 600.
   Do not print credentials, embed their values in tool calls, or enable
   shell tracing. Keep them outside the repository and public outputs.

3. Run, replacing PRIVATE_DIR with the extraction directory:
   node apps/ssh.mjs exec --credentials-dir PRIVATE_DIR \
     --user wr --port 22 --timeout 60 -- 'hostname; id; uname -a'
   Enforce a 75-second external timeout and stop the child on timeout.

4. Keep SSH host-key and TLS verification enabled. Use the bundled relay
   map and existing HTTPS_PROXY/HTTP_PROXY/NO_PROXY and trusted-CA settings.
   Do not alter sandbox permissions, install native Tailcat, use a hosted
   gateway, or change the remote server. This test must use local WASM.

5. If connection setup fails, retry once with --diagnostics and the same
   time limits. Report the failing stage and sanitized error codes.
   Never print proxy credentials, the Tailcat address, or the private key.

6. Report Node version, repository commit, elapsed time, exit status,
   and sanitized stdout/stderr. Distinguish a transport failure from a
   remote command's nonzero exit status. Do not claim success without exit 0.

7. In all cases, stop helper processes and remove extracted credential
   copies. Preserve the original uploaded ZIP. Do not revoke or modify keys.
```
