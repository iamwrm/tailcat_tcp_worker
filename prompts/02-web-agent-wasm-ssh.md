# Use the ZIP

Upload the ZIP, fill in the hostname and username, and paste this prompt.

```text
Use the uploaded ZIP to run SSH through local Tailcat WASM.
Repository: https://github.com/iamwrm/tailcat_wasm
Hostname or SSH alias: <HOSTNAME>
SSH username: <USERNAME>
SSH port: <PORT, default 22>
Ask for the hostname or username if either is missing.
Connect through the ZIP's Tailcat address. The hostname names the target;
the SSH host key verifies it. The CLI has no --host option.

1. Clone the repository or update to main. Use Node.js 22.15+.
   Run npm ci --omit=dev, npm run download, and npm run check from the repository root.
   Use the verified WASM release asset. No Go build or native ssh/tailcat is needed.

2. Require exactly these ZIP entries: id_ed25519, tailcat-address.txt,
   ssh-host-key.pub. Reject extra paths, symlinks, and duplicate entries.
   Extract outside the repository into a temporary directory with mode 700.
   Set files to mode 600. Do not print secrets, put their values in tool
   calls, or enable shell tracing.

3. Replace PRIVATE_DIR, USERNAME, and PORT, quoting values:
   node apps/ssh.mjs exec --credentials-dir PRIVATE_DIR \
     --user USERNAME --port PORT --timeout 60 -- 'hostname; id; uname -a'
   Stop the process if it runs longer than 75 seconds.

4. Keep SSH host-key and TLS checks enabled. Use the bundled relay map and
   existing proxy and CA settings. Leave sandbox permissions and the server
   unchanged. Do not install native Tailcat or use a hosted gateway.

5. If connection setup fails, retry once with --diagnostics and the same
   timeout. Report the failing stage and error code. Never bypass a host-key
   mismatch or print proxy credentials, the Tailcat address, or private key.

6. Report hostname, username, port, Node version, commit, elapsed time,
   exit status, stdout, and stderr. Remove secrets from output. Include the
   server's actual hostname; it may differ from an alias. Separate connection
   errors from command errors. Exit 0 is required for this test to pass.

7. Stop helpers and delete extracted credential copies, including on failure.
   Keep the uploaded ZIP. Leave authorized keys unchanged.
```
