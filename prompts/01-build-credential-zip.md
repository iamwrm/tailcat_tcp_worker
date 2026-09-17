# Build the credential ZIP

Paste this into an agent with trusted SSH access to the target. Edit the target
settings if needed. This prompt authorizes adding one dedicated SSH public key.

```text
Create a private credential ZIP for the local Tailcat WASM SSH client.
Target SSH alias: ubuntu-n150-1
SSH user: wr; destination port: 22
Remote Tailcat address file: ~/.local/state/tailcat-worker/address
Repository: https://github.com/iamwrm/tailcat_tcp_worker

1. Use the existing trusted SSH connection to the target. Keep host-key
   verification enabled. If its identity is not already trusted, ask me
   for a trusted host key before connecting; do not trust ssh-keyscan alone.

2. Create a private staging directory (700) outside the repository.
   Generate a fresh Ed25519 key named id_ed25519, without a passphrase,
   for unattended use. Give it a unique, identifiable key comment.
   Do not reuse, replace, or print any existing private key.

3. Append only the new public key to wr's ~/.ssh/authorized_keys,
   avoiding duplicates and preserving all existing entries and options.
   Ensure correct ownership and permissions (.ssh 700, authorized_keys 600).
   Do not change sshd configuration or other access settings.

4. Through the trusted SSH connection, read the existing short Tailcat
   address into tailcat-address.txt without displaying its contents.
   Read /etc/ssh/ssh_host_ed25519_key.pub into ssh-host-key.pub.
   Confirm the existing Tailcat service exposes destination port 22.
   If the address or service is unavailable, report that prerequisite.

5. Clone or update the repository. Run npm ci --omit=dev and npm run check.
   Test the new files with:
   node apps/ssh.mjs exec --credentials-dir PRIVATE_DIR \
     --user wr --port 22 --timeout 60 -- 'hostname; id'
   Keep host-key and TLS verification enabled; use a 75-second outer timeout.

6. After success, create a mode-600 ZIP in my private output directory,
   outside the repository. Do not overwrite an existing ZIP.
   Include exactly these root entries: id_ed25519, tailcat-address.txt,
   ssh-host-key.pub. Check the names and contents without printing secrets.
   Remove staging copies after verifying the ZIP; preserve the ZIP itself.

7. Give me the ZIP path, SSH username/port, sanitized test result, and the
   new key's comment/public fingerprint so I can revoke it later.
   Never commit or publicly upload the ZIP, address, or private key.
   The ZIP contains unencrypted credentials; I will upload it privately.
```
