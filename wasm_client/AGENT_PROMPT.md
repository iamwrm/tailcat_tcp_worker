Use this prompt with the private credential ZIP:

```text
Test the local Tailcat WASM client in your Linux sandbox.
Repository: https://github.com/iamwrm/tailcat_tcp_worker
Use wasm_client/, not the Cloudflare Worker or native Tailcat.

The uploaded ZIP contains id_ed25519, tailcat-address.txt,
and ssh-host-key.pub. SSH username: wr. Destination port: 22.

1. Clone the repository. Use Node.js 22.15 or newer.
   If already cloned, update to the latest main (including the slow-proxy startup fix).
   From the repository root, run:
   npm ci --omit=dev
   node wasm_client/verify.mjs

2. Extract the three uploaded files into a private directory (700),
   with files mode 600. Do not print credentials, embed their values
   in tool calls, or enable shell tracing.

3. Run this command, replacing only the credential directory path:
   node wasm_client/ssh.mjs exec \
     --credentials-dir /private/extracted-credentials \
     --user wr --port 22 --timeout 60 -- 'hostname; id; uname -a'

4. Enforce a 75-second external timeout. Keep host verification enabled.
   Use the bundled relay map and existing proxy/CA environment settings.
   Do not install native Tailcat, change sandbox permissions, or use
   the Worker as a fallback: this test must use local WASM and DERP.

5. Report Node version, repository commit, elapsed time, sanitized
   stdout/stderr, and exit status. If blocked, identify the failing
   stage (artifact loading, HTTPS, relay WebSocket, or SSH).
   Do not print the Tailcat address or private key.

6. Stop helper processes and remove extracted credential copies.
   Preserve the original upload. Do not modify the remote server.
```
