import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, cpSync, chmodSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = root + 'worker/';
const env = { ...process.env, GOTOOLCHAIN: 'go1.27.1' };
const go = (...args) => execFileSync('go', args, { cwd: worker, env, encoding: 'utf8' });
mkdirSync(worker + 'src/generated', { recursive: true });
writeFileSync(worker + 'public/transport-protocol.txt', readFileSync(root + 'PROTOCOL.md'));
// Remove the obsolete generated download from pre-TCP-only builds.
rmSync(worker + 'public/shell.py', { force: true });
for (const name of ['transport.mjs', 'transport-client.mjs']) {
  cpSync(root + 'client/' + name, worker + 'public/' + name);
}
const tags = go('run', root + 'scripts/tags.go').trim();
// Expose graceful TCP shutdown using a private copy of the pinned dependency.
// Never modify the shared Go module cache. The small added method is reviewed source.
const gvisor = go('list', '-m', '-f', '{{.Dir}}', 'gvisor.dev/gvisor').trim();
const version = go('list', '-m', '-f', '{{.Version}}', 'gvisor.dev/gvisor').trim();
const patched = worker + '.wrangler/gvisor-' + version;
if (!existsSync(patched)) cpSync(gvisor, patched, { recursive: true });
const gonetPath = '/pkg/tcpip/adapters/gonet/gonet.go';
chmodSync(patched + gonetPath, 0o644);
writeFileSync(patched + gonetPath, readFileSync(gvisor + gonetPath, 'utf8') + readFileSync(root + 'scripts/gonet-drain.go.txt', 'utf8'), { mode: 0o644 });
const buildMod = worker + '.wrangler/build.go.mod';
writeFileSync(buildMod, readFileSync(worker + 'go.mod', 'utf8') + '\nreplace gvisor.dev/gvisor => ' + JSON.stringify(patched) + '\n');
writeFileSync(worker + '.wrangler/build.go.sum', readFileSync(worker + 'go.sum'));
writeFileSync(root + 'GVISOR-LICENSE', readFileSync(gvisor + '/LICENSE'));
execFileSync('go', ['build', '-modfile', buildMod, '-trimpath', '-tags', tags, '-ldflags=-s -w', '-o', 'src/generated/tailcat.wasm', './cmd/workerwasm'], {
  cwd: worker, env: { ...env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
const goroot = go('env', 'GOROOT').trim();
// Each Go instance sees a private global object. No eval or runtime compilation.
const runtime = readFileSync(goroot + '/lib/wasm/wasm_exec.js', 'utf8').replaceAll('globalThis', 'scope').replaceAll('fs.writeSync', 'scope.fs.writeSync');
writeFileSync(worker + 'src/generated/go-runtime.js',
  '// Generated from the pinned Go toolchain. See GO-LICENSE.\n' +
  'export function makeGo(scope) {\nconst {setTimeout, clearTimeout, console} = scope;\n' + runtime + '\nreturn new scope.Go();\n}\n');
if (!existsSync(root + 'GO-LICENSE')) writeFileSync(root + 'GO-LICENSE', readFileSync(goroot + '/LICENSE'));
const bytes = readFileSync(worker + 'src/generated/tailcat.wasm');
console.log(JSON.stringify({ wasm_bytes: statSync(worker + 'src/generated/tailcat.wasm').size, gzip_bytes: gzipSync(bytes).length }));
