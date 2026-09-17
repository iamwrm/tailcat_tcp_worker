# Create the ZIP

Fill in the hostname and username. Give this prompt to an agent that already
has SSH access to the server.

```text
Create a ZIP for Tailcat WASM SSH.
Hostname or SSH alias: <HOSTNAME>
SSH username: <USERNAME>
SSH port: <PORT, default 22>
Repository: https://github.com/iamwrm/tailcat_wasm
Ask for the hostname or username if either is missing.

1. Connect to the server as this user. Verify its SSH host key. If no
   trusted key is available, ask me for one. ssh-keyscan alone is not proof.

2. Create a temporary directory outside the repository with mode 700.
   Generate a new Ed25519 key named id_ed25519, without a passphrase.
   Give it a unique comment. Keep the private key local and mode 600.

3. Add the public key to this user's authorized_keys. Preserve existing
   entries and options. Avoid duplicates. Check ownership and permissions:
   .ssh 700, authorized_keys 600. Leave sshd and other accounts unchanged.

4. Find the existing Tailcat service and short address file. Ask for the
   file path if needed. Copy the address into tailcat-address.txt.
   Copy the SSH server's host public key through the verified SSH connection
   into ssh-host-key.pub. Confirm Tailcat exposes the requested SSH port.
   If the service or address is missing, report it; do not create a service.

5. Clone the repository or update to main. Run npm ci --omit=dev and
   npm run check. Replace PRIVATE_DIR, USERNAME, and PORT, quoting values:
   node apps/ssh.mjs exec --credentials-dir PRIVATE_DIR \
     --user USERNAME --port PORT --timeout 60 -- 'hostname; id'
   Keep SSH host-key and TLS checks enabled. Stop the process after 75 seconds.

6. If the test passes, create a mode-600 ZIP outside the repository.
   Do not overwrite an existing ZIP. Include only these files at its root:
   id_ed25519, tailcat-address.txt, ssh-host-key.pub.
   Check the ZIP contents, then delete the temporary credential copies.

7. Report the ZIP path, hostname, username, port, test output, and the new
   key's comment and public fingerprint. Report the server's actual hostname.
   Remove secrets from output. Never print, commit, or publicly upload the
   private key, Tailcat address, or ZIP. I will upload the ZIP privately.
```
