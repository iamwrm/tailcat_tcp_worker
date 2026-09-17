// Build the standalone local transport from pinned Go sources.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, chmodSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDir = root + 'wasm_client/go/';
const buildDir = root + 'wasm_client/.build/';
const dist = root + 'wasm_client/dist/';
const env = { ...process.env, GOTOOLCHAIN: 'go1.27.1' };
const go = (...args) => execFileSync('go', args, { cwd: sourceDir, env, encoding: 'utf8' }).trim();
mkdirSync(buildDir, { recursive: true });
mkdirSync(dist, { recursive: true });
const tags = go('run', root + 'scripts/tags.go');
// Private copies keep the shared module cache unchanged. Exact-match overlays
// extend upstream startup deadlines for slow HTTPS proxies; fail on source drift.
let buildMod = readFileSync(sourceDir + 'go.mod', 'utf8');
const modules = {};
for (const module of ['github.com/tailscale/tailcat', 'tailscale.com', 'gvisor.dev/gvisor']) {
  const source = go('list', '-m', '-f', '{{.Dir}}', module);
  const destination = buildDir + source.split('/').at(-1);
  if (!existsSync(destination)) cpSync(source, destination, { recursive: true });
  modules[module] = { source, destination };
  buildMod += '\nreplace ' + module + ' => ' + JSON.stringify(destination) + '\n';
}
const gonet = '/pkg/tcpip/adapters/gonet/gonet.go';
const gvisor = modules['gvisor.dev/gvisor'];
chmodSync(gvisor.destination + gonet, 0o644);
writeFileSync(gvisor.destination + gonet, readFileSync(gvisor.source + gonet, 'utf8') + readFileSync(root + 'scripts/gonet-drain.go.txt', 'utf8'));
writeFileSync(root + 'GVISOR-LICENSE', readFileSync(gvisor.source + '/LICENSE'));
writeFileSync(buildDir + 'build.go.mod', buildMod);
writeFileSync(buildDir + 'build.go.sum', readFileSync(sourceDir + 'go.sum'));
const replacements = [
  [modules['github.com/tailscale/tailcat'].destination + '/tailcat.go',
    'func (c *Client) ping(ctx context.Context) (PingResult, error) {\n\tctx, cancel := context.WithTimeout(ctx, 10*time.Second)',
    'func (c *Client) ping(ctx context.Context) (PingResult, error) {\n\tctx, cancel := context.WithTimeout(ctx, 30*time.Second)'],
  [modules['tailscale.com'].destination + '/derp/derphttp/derphttp_client.go',
    'const timeout = 10 * time.Second', 'const timeout = 30 * time.Second'],
];
const Replace = {};
for (const [index, [source, before, after]] of replacements.entries()) {
  const contents = readFileSync(source, 'utf8');
  if (contents.split(before).length !== 2) throw new Error('Startup overlay no longer matches pinned source: ' + source);
  const destination = buildDir + 'deadline-' + index + '.go';
  writeFileSync(destination, contents.replace(before, after));
  Replace[source] = destination;
}
writeFileSync(buildDir + 'overlay.json', JSON.stringify({ Replace }));
execFileSync('go', ['build', '-overlay', buildDir + 'overlay.json', '-modfile', buildDir + 'build.go.mod',
  '-trimpath', '-tags', tags, '-ldflags=-s -w', '-o', buildDir + 'tailcat.wasm', './cmd/tailcatwasm'], {
  cwd: sourceDir, env: { ...env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
const goroot = go('env', 'GOROOT');
const runtime = readFileSync(goroot + '/lib/wasm/wasm_exec.js', 'utf8').replaceAll('globalThis', 'scope').replaceAll('fs.writeSync', 'scope.fs.writeSync');
writeFileSync(dist + 'go-runtime.js', '// Generated from the pinned Go toolchain. See GO-LICENSE.\n' +
  'export function makeGo(scope) {\nconst {setTimeout, clearTimeout, console} = scope;\n' + runtime + '\nreturn new scope.Go();\n}\n');
if (!existsSync(root + 'GO-LICENSE')) writeFileSync(root + 'GO-LICENSE', readFileSync(goroot + '/LICENSE'));
const wasm = readFileSync(buildDir + 'tailcat.wasm');
const compressed = gzipSync(wasm, { level: 9 });
writeFileSync(dist + 'tailcat.wasm.gz', compressed);
const sha256 = data => createHash('sha256').update(data).digest('hex');
writeFileSync(dist + 'manifest.json', JSON.stringify({
  format: 1, go: 'go1.27.1', target: 'js/wasm', source: 'wasm_client/go/cmd/tailcatwasm',
  startupTimeoutSeconds: { relay: 30, ping: 30, dial: 40 },
  files: {
    'tailcat.wasm.gz': { bytes: compressed.length, sha256: sha256(compressed) },
    'tailcat.wasm': { bytes: wasm.length, sha256: sha256(wasm) },
    'go-runtime.js': { sha256: sha256(readFileSync(dist + 'go-runtime.js')) },
  },
}, null, 2) + '\n');
console.log('Packaged local WASM client (no runtime download or Go installation needed).');
