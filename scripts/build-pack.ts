// 產生參賽包（軍備競賽執行手冊「參賽包」）：輸出到 out/pack（或第一個參數指定的目錄）。
// 用法：node scripts/build-pack.ts [輸出目錄]
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, SPEC_VERSION } from '../src/config/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'out', 'pack'));
const specFile = join(root, 'docs', `RTS 對戰引擎與選手 API 規格書 v${SPEC_VERSION}.md`);

if (!existsSync(specFile)) throw new Error(`找不到規格書：${specFile}`);
execSync('npm run build', { cwd: root, stdio: 'inherit' });
execSync('npm run build:web', { cwd: root, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(specFile, join(out, 'spec.md'));
cpSync(join(root, 'pack', 'README.md'), join(out, 'README.md'));
mkdirSync(join(out, 'bots'));
for (const f of ['baseline.js', 'template.js']) cpSync(join(root, 'bots', f), join(out, 'bots', f));
cpSync(join(root, 'dist', 'src'), join(out, 'engine'), { recursive: true });
cpSync(join(root, 'node_modules', 'acorn'), join(out, 'node_modules', 'acorn'), { recursive: true });
cpSync(join(root, 'dist-web'), join(out, 'viewer'), { recursive: true });
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'rts-sim-pack', private: true, type: 'module', engineVersion: ENGINE_VERSION, specVersion: SPEC_VERSION }, null, 2)}\n`);
writeFileSync(join(out, 'rts-sim.mjs'), "import './engine/cli/main.js';\n");
mkdirSync(join(out, 'versions'));
writeFileSync(join(out, 'versions', '.keep'), '');
writeFileSync(join(out, 'CHANGELOG.md'), '');
writeFileSync(join(out, 'BUGS.md'), '');
process.stdout.write(`參賽包已輸出：${out}（引擎 ${ENGINE_VERSION}／規格 ${SPEC_VERSION}）\n`);
