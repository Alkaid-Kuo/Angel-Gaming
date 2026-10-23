// 把 bots/legion-src/ 的共用函式庫（base.js）與各流派合併成單一檔案的選手模組 bots/legion-*.js（選手模組不能 import）。
// 用法：node scripts/build-legion-bots.ts          產生
//       node scripts/build-legion-bots.ts --check  只檢查產生的檔案是否和原始碼一致（不一致時結束碼為 1）
import { readFileSync, writeFileSync } from 'node:fs';

export const LEGION_STRATEGIES = ['push', 'ambush', 'ranged'] as const;

const lines = (s: string): string[] => s.replaceAll('\r\n', '\n').split('\n');

export function buildLegionBot(name: (typeof LEGION_STRATEGIES)[number]): string {
  const base = lines(readFileSync('bots/legion-src/base.js', 'utf8'));
  const body = lines(readFileSync(`bots/legion-src/${name}.js`, 'utf8'));
  const firstImport = body.findIndex((l) => l.startsWith('import '));
  // 流派檔案 import 之前的說明註解放在最前面
  const head = body.slice(0, firstImport).filter((l) => l.startsWith('//') && l !== '// @ts-check');
  const rest = body
    .slice(firstImport)
    .filter((l) => !l.startsWith('import ') && !l.startsWith('/** @typedef') && !/^export \{/.test(l))
    .map((l) => l.replaceAll("import('./base.js').", ''));
  // 共用函式庫：去掉檔頭註解與頂層 export，typedef 的路徑改成 bots/ 底下的相對路徑
  const baseStart = base.findIndex((l) => !l.startsWith('//') && l.trim() !== '');
  const lib = base.slice(baseStart).map((l) => l.replace(/^export (class|const|function) /, '$1 ').replaceAll("'../../src/", "'../src/"));
  const out = ['// @ts-check', ...head, '// 本檔由 scripts/build-legion-bots.ts 從 bots/legion-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。', '', ...lib, ...rest];
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function current(path: string): string {
  try {
    return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  } catch {
    return '';
  }
}

if (process.argv[1]?.endsWith('build-legion-bots.ts')) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const name of LEGION_STRATEGIES) {
    const out = buildLegionBot(name);
    const path = `bots/legion-${name}.js`;
    if (check) {
      if (current(path) !== out) {
        stale += 1;
        console.log(`過期：${path}`);
      }
    } else {
      writeFileSync(path, out);
      console.log(`產生 ${path}`);
    }
  }
  if (check && stale > 0) process.exit(1);
}
