// Reuse the pinned, reviewed Go transport and its graceful TCP shutdown patch.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
// Slow HTTPS proxies can spend ten seconds establishing a relay tunnel. Extend
// startup deadlines only in this local artifact, without editing the module
// cache or changing the deployed Worker's build.
const worker = root + 'worker/';
const env = { ...process.env, GOTOOLCHAIN: 'go1.27.1' };
const go = (...args) => execFileSync('go', args, { cwd: worker, env, encoding: 'utf8' }).trim();
const overlayDir = worker + '.wrangler/wasm-client-overlay/';
mkdirSync(overlayDir, { recursive: true });
let buildMod = readFileSync(worker + '.wrangler/build.go.mod', 'utf8');
const modules = {};
for (const module of ['github.com/tailscale/tailcat', 'tailscale.com']) {
  const source = go('list', '-m', '-f', '{{.Dir}}', module);
  const destination = overlayDir + source.split('/').at(-1);
  if (!existsSync(destination)) cpSync(source, destination, { recursive: true });
  modules[module] = destination;
  buildMod += '\nreplace ' + module + ' => ' + JSON.stringify(destination) + '\n';
}
writeFileSync(overlayDir + 'build.go.mod', buildMod);
copyFileSync(worker + '.wrangler/build.go.sum', overlayDir + 'build.go.sum');
const replacements = [
  [modules['github.com/tailscale/tailcat'] + '/tailcat.go',
    'func (c *Client) ping(ctx context.Context) (PingResult, error) {\n\tctx, cancel := context.WithTimeout(ctx, 10*time.Second)',
    'func (c *Client) ping(ctx context.Context) (PingResult, error) {\n\tctx, cancel := context.WithTimeout(ctx, 30*time.Second)'],
  [modules['tailscale.com'] + '/derp/derphttp/derphttp_client.go',
    'const timeout = 10 * time.Second', 'const timeout = 30 * time.Second'],
  [worker + 'cmd/workerwasm/connector.go',
    'context.WithTimeout(ctx, 20*time.Second)', 'context.WithTimeout(ctx, 40*time.Second)'],
];
const Replace = {};
for (const [index, [source, before, after]] of replacements.entries()) {
  const contents = readFileSync(source, 'utf8');
  if (contents.split(before).length !== 2) throw new Error('Startup overlay no longer matches pinned source: ' + source);
  const destination = overlayDir + index + '.go';
  writeFileSync(destination, contents.replace(before, after));
  Replace[source] = destination;
}
writeFileSync(overlayDir + 'overlay.json', JSON.stringify({ Replace }));
execFileSync('go', ['build', '-overlay', overlayDir + 'overlay.json', '-modfile', overlayDir + 'build.go.mod',
  '-trimpath', '-tags', go('run', root + 'scripts/tags.go'), '-ldflags=-s -w',
  '-o', overlayDir + 'tailcat.wasm', './cmd/workerwasm'], {
  cwd: worker, env: { ...env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
const dist = root + 'wasm_client/dist/';
mkdirSync(dist, { recursive: true });
const wasm = readFileSync(overlayDir + 'tailcat.wasm');
const compressed = gzipSync(wasm, { level: 9 });
writeFileSync(dist + 'tailcat.wasm.gz', compressed);
copyFileSync(root + 'worker/src/generated/go-runtime.js', dist + 'go-runtime.js');
const sha256 = data => createHash('sha256').update(data).digest('hex');
writeFileSync(dist + 'manifest.json', JSON.stringify({
  format: 1, go: 'go1.27.1', target: 'js/wasm',
  source: 'worker/cmd/workerwasm',
  startupTimeoutSeconds: { relay: 30, ping: 30, dial: 40 },
  files: {
    'tailcat.wasm.gz': { bytes: compressed.length, sha256: sha256(compressed) },
    'tailcat.wasm': { bytes: wasm.length, sha256: sha256(wasm) },
    'go-runtime.js': { sha256: sha256(readFileSync(dist + 'go-runtime.js')) },
  },
}, null, 2) + '\n');
console.log('Packaged local WASM client (no runtime download or Go installation needed).');
