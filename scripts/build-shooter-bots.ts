// 把 bots/shooter-src/ 的多個原始碼檔案合併成單一檔案的選手模組 bots/shooter-baseline.js（選手模組不能 import）。
// 從入口 baseline.js 開始，依 import 順序展開本地模組（先展開被依賴的），去掉 import／export 與跨檔的型別前綴。
// 步驟 7 起合成時剝掉整行註解、空行與只有說明的 JSDoc（有 @ 標籤的保留，產生檔仍然能型別檢查）；原始碼保留註解，--check 比對剝過的結果。
// 用法：node scripts/build-shooter-bots.ts          產生
//       node scripts/build-shooter-bots.ts --check  只檢查產生的檔案是否和原始碼一致（不一致時結束碼為 1）
import { readFileSync, writeFileSync } from 'node:fs';

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
 * 剝註解：整行 // 註解、空行；JSDoc 只保留型別標籤（第一個 @ 以前的說明行拿掉，整塊沒有 @ 就整塊拿掉）。
 * 只動整行，不碰行內的字串、正規表示式與行內型別轉換。
 */
export function stripComments(src: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    const t = l.trim();
    if (t === '' || (t.startsWith('//') && t !== '// @ts-check')) continue;
    if (t.startsWith('/**') && !t.includes('*/')) {
      let j = i;
      while (j < src.length && !src[j].includes('*/')) j++;
      const block = src.slice(i, j + 1);
      const first = block.findIndex((x) => x.includes('@'));
      if (first >= 0) out.push(...(first === 0 ? block : [block[0].replace(/\/\*\*.*$/, '/**'), ...block.slice(first)]));
      i = j;
      continue;
    }
    if (t.startsWith('/**') && t.endsWith('*/') && !t.includes('@')) continue;
    out.push(l);
  }
  return out;
}

export function buildShooterBot(entry: string): string {
  const files: string[] = [];
  order(entry, new Set(), files);
  const head = body(entry, true);
  const firstCode = head.findIndex((l) => !l.startsWith('//'));
  const out = [
    '// @ts-check',
    ...head.slice(0, firstCode),
    '// 本檔由 scripts/build-shooter-bots.ts 從 bots/shooter-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。',
    '',
    ...stripComments(files.filter((f) => f !== entry).flatMap((f) => body(f, false))),
    ...stripComments(head.slice(firstCode)),
  ];
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
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
