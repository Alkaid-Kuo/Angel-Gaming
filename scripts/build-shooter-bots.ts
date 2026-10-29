// 把 bots/shooter-src/ 的多個原始碼檔案合併成單一檔案的選手模組 bots/shooter-baseline.js（選手模組不能 import）。
// 從入口 baseline.js 開始，依 import 順序展開本地模組（先展開被依賴的），去掉 import／export 與跨檔的型別前綴。
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
    ...files.filter((f) => f !== entry).flatMap((f) => [...body(f, false), '']),
    ...head.slice(firstCode),
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
