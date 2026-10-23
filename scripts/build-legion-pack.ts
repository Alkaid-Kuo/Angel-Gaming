// 產生軍團戰參賽包：交給外部 AI 從零開始寫軍團戰選手。只放規則、引擎、三隻陪練與工具，不放任何訓練相關資料。
// 用法：node scripts/build-legion-pack.ts [輸出目錄] [--force]
//   預設輸出到 out/legion-pack，並壓成同名的 .zip（zip 內的頂層資料夾是 legion-pack/）。
//   輸出目錄或 zip 已存在時要加 --force 才會刪掉重建。
// 包內的引擎檔案由工具（match.ts、trace.ts）的 import 遞迴找出（只跟執行期的 import，另外加上選手 API 的型別檔）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { parse } from 'acorn';
import { LEGION_ENGINE_VERSION } from '../src/legion/config.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const outArg = argv.find((a) => !a.startsWith('--'));
const out = resolve(outArg ?? join(root, 'out', 'legion-pack'));
const zipPath = `${out}.zip`;
const zipTop = basename(out);

const SPEC = join(root, 'docs', '軍團戰 選手規格書.md');
const DATASHEET = join(root, 'docs', '軍團戰 數值總表.md');
const PACK_SRC = join(root, 'pack', 'legion');
/** 包內的工具（放在包的根目錄；import 路徑以包的根目錄為準，也就是專案根目錄） */
const TOOLS = ['match.ts', 'trace.ts'];
/** 三隻陪練（複製時剝掉所有註解，只留一行中性的檔頭） */
const SPARRING = ['legion-push.js', 'legion-ambush.js', 'legion-ranged.js'];
/** 只有型別、執行期用不到，但選手要看的 API 型別檔 */
const TYPE_FILES = ['src/legion/api.ts', 'src/api/types.ts'];
/** 絕對不能進包的檔案（路徑比對） */
const FORBIDDEN_PATHS = [/acceptance/, /ai-scenarios/, /legion-src/, /commander/, /estimate/, /^src\/web\//, /calibrat/, /bench/, /_legion_/, /duels/];
/** 掃描包內文字檔時要回報的字樣（不阻擋，只列出來給人判斷） */
const WATCH_WORDS = /commander|統帥|estimate|估算|ai-scenarios|acceptance|驗收|情境|\bS1[0-9]\b|官方|基準|calibrat|校準|bench|legion-src/i;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

for (const f of [SPEC, DATASHEET, join(PACK_SRC, 'README.md'), join(PACK_SRC, 'template.js'), ...TOOLS.map((t) => join(PACK_SRC, t)), ...SPARRING.map((b) => join(root, 'bots', b))]) {
  if (!existsSync(f)) fail(`找不到 ${relative(root, f)}`);
}
for (const p of [out, zipPath]) {
  if (existsSync(p) && !force) fail(`${p} 已存在；確定要覆蓋請加 --force`);
}

// ───────── 引擎檔案：從工具的 import 遞迴找 ─────────

const IMPORT_RE = /^\s*import\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const REEXPORT_RE = /^\s*export\s+(type\s+)?[^;'"]*?\s+from\s+['"]([^'"]+)['"]/gm;

/** 一個檔案在執行期 import 的相對路徑（以專案根目錄為準的 posix 路徑） */
function runtimeImports(file: string, baseDir: string): string[] {
  const src = readFileSync(file, 'utf8');
  const outList: string[] = [];
  for (const re of [IMPORT_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      if (m[1] !== undefined) continue;
      const spec = m[2];
      if (!spec.startsWith('.')) continue;
      outList.push(relative(root, resolve(baseDir, spec)).split(sep).join('/'));
    }
  }
  return outList;
}

const engine = new Set<string>();
const queue: string[] = [...TYPE_FILES];
for (const t of TOOLS) queue.push(...runtimeImports(join(PACK_SRC, t), root));
while (queue.length > 0) {
  const rel = queue.shift()!;
  if (engine.has(rel)) continue;
  const abs = join(root, rel);
  if (!existsSync(abs)) fail(`找不到被 import 的檔案 ${rel}`);
  engine.add(rel);
  queue.push(...runtimeImports(abs, dirname(abs)));
}
for (const rel of engine) {
  if (!rel.startsWith('src/')) fail(`引擎檔案不在 src/ 底下：${rel}`);
  for (const re of FORBIDDEN_PATHS) if (re.test(rel)) fail(`不能放進包的檔案被 import 到了：${rel}`);
}

// ───────── 陪練：剝掉註解 ─────────

const ACORN_OPTS = { ecmaVersion: 2020, sourceType: 'module' } as const;

/**
 * 剝掉所有註解（行註解、區塊註解、JSDoc），程式碼不動：
 * 整行都是註解的行刪掉；行中間的註解換成一個空白（避免前後的記號黏在一起），行尾的註解連同前面的空白刪掉。
 * 跨行的區塊註解只刪註解本身，行與行之間的換行都保留（不影響自動補分號）。
 */
function stripComments(src: string): string {
  const inComment = new Uint8Array(src.length);
  parse(src, {
    ...ACORN_OPTS,
    onComment: (_block: boolean, _text: string, start: number, end: number) => {
      inComment.fill(1, start, end);
    },
  });
  const outLines: string[] = [];
  let pos = 0;
  for (const raw of src.split('\n')) {
    const lineStart = pos;
    pos += raw.length + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let hasCode = false;
    let hasComment = false;
    let lastCodeIsComment = false;
    for (let i = 0; i < line.length; i++) {
      const c = inComment[lineStart + i] === 1;
      if (c) hasComment = true;
      if (/\S/.test(line[i])) {
        if (!c) hasCode = true;
        lastCodeIsComment = c;
      }
    }
    if (!hasComment) {
      outLines.push(line);
      continue;
    }
    if (!hasCode) continue;
    let s = '';
    for (let i = 0; i < line.length; i++) {
      if (inComment[lineStart + i] !== 1) {
        s += line[i];
        continue;
      }
      let j = i;
      while (j < line.length && inComment[lineStart + j] === 1) j += 1;
      const next = line[j];
      const prevWs = s.length === 0 || /\s/.test(s[s.length - 1]);
      if (next !== undefined) {
        if (prevWs && /\s/.test(next)) j += 1;
        else if (!prevWs && !/\s/.test(next)) s += ' ';
      }
      i = j - 1;
    }
    outLines.push(lastCodeIsComment ? s.trimEnd() : s);
  }
  return outLines.join('\n');
}

/** AST 的比對鍵（去掉位置資訊）：剝註解前後必須完全相同，保證行為不變 */
function astKey(src: string): string {
  return JSON.stringify(parse(src, ACORN_OPTS), (k, v: unknown) => (k === 'start' || k === 'end' || k === 'loc' || k === 'range' ? undefined : v));
}

function sparringSource(file: string): string {
  const src = readFileSync(join(root, 'bots', file), 'utf8');
  const name = file.replace(/^legion-/, '').replace(/\.js$/, '');
  const stripped = `// 軍團戰陪練對手（${name}）\n${stripComments(src).replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n')}`;
  if (astKey(stripped) !== astKey(src)) fail(`${file}：剝掉註解後語法樹不同，停止組包`);
  if (/\/\/|\/\*/.test(stripped.split('\n').slice(1).join('\n').replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ''))) {
    process.stderr.write(`注意：${file} 剝掉註解後仍有疑似註解的字樣（可能是字串內容），請人工確認\n`);
  }
  compileBot(stripped, file);
  return stripped;
}

// ───────── 組包 ─────────

if (force) {
  rmSync(out, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
}
mkdirSync(out, { recursive: true });
const copy = (from: string, to: string): void => {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(from, join(out, to), { recursive: true });
};

copy(join(PACK_SRC, 'README.md'), 'README.md');
copy(SPEC, 'spec.md');
// 數值總表：檔頭的產生方式說明改成包內適用的說法
const sheet = readFileSync(DATASHEET, 'utf8').replace(/\*\*這份文件由[^\n]*/, '本表由引擎數值自動產生，供速查；與 `spec.md` 不一致時以 `spec.md` 為準。');
writeFileSync(join(out, 'datasheet.md'), sheet);
for (const t of TOOLS) copy(join(PACK_SRC, t), t);
copy(join(PACK_SRC, 'template.js'), 'bots/template.js');
mkdirSync(join(out, 'bots'), { recursive: true });
for (const b of SPARRING) writeFileSync(join(out, 'bots', b), sparringSource(b));
for (const rel of [...engine].sort()) copy(join(root, rel), rel);
copy(join(root, 'node_modules', 'acorn'), 'node_modules/acorn');
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify({ name: 'legion-pack', private: true, type: 'module', description: '軍團戰 選手開發包', engines: { node: '>=22.18' }, legionEngineVersion: LEGION_ENGINE_VERSION }, null, 2)}\n`,
);
mkdirSync(join(out, 'versions'));
writeFileSync(join(out, 'versions', '.keep'), '');
writeFileSync(join(out, 'CHANGELOG.md'), '# CHANGELOG\n\n<!-- 每個版本一行：版本 | 殲滅戰對三隻陪練的勝率 | 佔點對三隻陪練的勝率 | 變更 -->\n');
writeFileSync(join(out, 'BUGS.md'), '# BUGS\n\n<!-- 引擎漏洞、規格與引擎不一致、規格不清之處：現象、重現方式（指令、種子、第幾秒） -->\n');

// ───────── 檢查與回報 ─────────

function walk(dir: string): string[] {
  const list: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) list.push(...walk(p));
    else list.push(p);
  }
  return list;
}

const files = walk(out);
const hits: string[] = [];
for (const f of files) {
  const rel = relative(out, f).split(sep).join('/');
  if (rel.startsWith('node_modules/')) continue;
  for (const re of FORBIDDEN_PATHS) if (re.test(rel)) fail(`包內出現不該有的檔案：${rel}`);
  readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (WATCH_WORDS.test(line)) hits.push(`  ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}

// ───────── 壓縮（zip：UTF-8 檔名、正斜線路徑，任何平台都能解） ─────────

function zipDir(dir: string, dest: string, top: string): void {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for (const f of walk(dir)) {
    const name = Buffer.from(posix.join(top, relative(dir, f).split(sep).join('/')), 'utf8');
    const data = readFileSync(f);
    const packed = deflateRawSync(data, { level: 9 });
    const deflate = packed.length < data.length;
    const body = deflate ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + body.length;
    count += 1;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(dest, Buffer.concat([...parts, cd, end]));
}

zipDir(out, zipPath, zipTop);

const lines = [
  `參賽包已輸出：${out}（引擎 ${LEGION_ENGINE_VERSION}，${files.length} 個檔案）`,
  `壓縮檔：${zipPath}（${(statSync(zipPath).size / 1024).toFixed(1)} KB）`,
  `引擎檔案（${engine.size} 個）：${[...engine].sort().join('、')}`,
  hits.length === 0 ? '字樣檢查：沒有需要注意的字樣' : `字樣檢查：以下 ${hits.length} 行含有需要注意的字樣（請人工判斷）：\n${hits.join('\n')}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
