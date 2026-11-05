// 把 bots/shooter-src/ 的多個原始碼檔案合併成單一檔案的選手模組 bots/shooter-baseline.js（選手模組不能 import）。
// 從入口 baseline.js 開始，依 import 順序展開本地模組（先展開被依賴的），去掉 import／export 與跨檔的型別前綴。
// 合成時用詞法分析重排：拿掉全部註解（含 JSDoc 型別標籤）、縮排與空行，token 之間有換行的保留換行（不改 ASI），同一行的空白縮成一格；
// 字串、template 與正規表示式整個原樣保留。原始碼保留註解與型別，型別檢查對 bots/shooter-src/ 做（產生檔不再型別檢查，tsconfig 排除）。
// --check 比對重排過的結果。2.7 起（2.6.3 以前保留型別標籤，產生檔 260 KB、只剩 2 KB）。
// 用法：node scripts/build-shooter-bots.ts          產生
//       node scripts/build-shooter-bots.ts --check  只檢查產生的檔案是否和原始碼一致（不一致時結束碼為 1）
import { readFileSync, writeFileSync } from 'node:fs';
import { tokenizer } from 'acorn';

export const SHOOTER_BOTS = [{ entry: 'baseline.js', out: 'bots/shooter-baseline.js' }] as const;

const SRC = 'bots/shooter-src';
const lines = (s: string): string[] => s.replaceAll('\r\n', '\n').split('\n');

/** 檔案 import 的本地模組，依相依順序（被依賴的在前、每個只出現一次） */
function order(file: string, seen: Set<string>, out: string[]): void {
  if (seen.has(file)) return;
  seen.add(file);
  for (const l of lines(readFileSync(`${SRC}/${file}`, 'utf8'))) {
    const m = /^import .* from '\.\/([\w-]+\.js)';$/.exec(l);
    if (m) order(m[1], seen, out);
  }
  out.push(file);
}

/** 去掉檔頭註解（入口除外）、import、export 關鍵字與跨檔型別前綴；typedef 路徑改成 bots/ 底下的相對路徑 */
function body(file: string, entry: boolean): string[] {
  const src = lines(readFileSync(`${SRC}/${file}`, 'utf8'));
  const start = entry ? 0 : src.findIndex((l) => !l.startsWith('//') && l.trim() !== '');
  return src
    .slice(start)
    .filter((l) => !l.startsWith('import ') && l !== '// @ts-check')
    .map((l) =>
      l
        .replace(/^export (class|const|function) /, '$1 ')
        .replace(/import\('\.\/[\w-]+\.js'\)\./g, '')
        .replaceAll("'../../src/", "'../src/"),
    );
}

/**
 * 剝註解與排版：依 acorn 的 token 重排，token 之間的間隔（空白、註解）有換行就換成一個換行，否則有東西就換成一格空白、沒有就不放。
 * token 本身（字串、template 片段、正規表示式）原樣保留，所以語意與 ASI 都不變；回傳的行沒有縮排與空行。
 */
export function stripComments(src: readonly string[]): string[] {
  const source = src.join('\n');
  let out = '';
  let last = 0;
  for (const token of tokenizer(source, { ecmaVersion: 2020, sourceType: 'module' })) {
    const gap = source.slice(last, token.start);
    if (out !== '') out += gap.includes('\n') ? '\n' : gap === '' ? '' : ' ';
    out += source.slice(token.start, token.end);
    last = token.end;
  }
  return out === '' ? [] : out.split('\n');
}

export function buildShooterBot(entry: string): string {
  const files: string[] = [];
  order(entry, new Set(), files);
  const head = body(entry, true);
  const firstCode = head.findIndex((l) => !l.startsWith('//'));
  const out = [
    ...head.slice(0, firstCode),
    '// 本檔由 scripts/build-shooter-bots.ts 從 bots/shooter-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。',
    '',
    ...stripComments(files.filter((f) => f !== entry).flatMap((f) => body(f, false))),
    ...stripComments(head.slice(firstCode)),
  ];
  return compactIndent(out.join('\n').trimEnd()) + '\n';
}

/** 產物移除縮排以留給行為邏輯空間；詞法分析保留多行字串／template 的原始空白，換行與 JSDoc 都保留。 */
export function compactIndent(source: string): string {
  const protectedRanges: [number, number][] = [];
  for (const token of tokenizer(source, { ecmaVersion: 2020, sourceType: 'module' })) {
    if (source.slice(token.start, token.end).includes('\n')) protectedRanges.push([token.start, token.end]);
  }
  return source.replace(/^ +/gm, (spaces: string, offset: number) => protectedRanges.some(([a, b]) => offset >= a && offset < b) ? spaces : '');
}

function current(path: string): string {
  try {
    return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  } catch {
    return '';
  }
}

if (process.argv[1]?.endsWith('build-shooter-bots.ts')) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const b of SHOOTER_BOTS) {
    const out = buildShooterBot(b.entry);
    if (check) {
      if (current(b.out) !== out) {
        stale += 1;
        console.log(`過期：${b.out}`);
      }
    } else {
      writeFileSync(b.out, out);
      console.log(`產生 ${b.out}（${Buffer.byteLength(out)} bytes）`);
    }
  }
  if (check && stale > 0) process.exit(1);
}
