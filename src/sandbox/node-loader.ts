// Node 端：讀取選手檔案並編譯（批次模式直接使用；正式模式把原始碼交給 Worker）。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { BotLoadError, compileBot, type CompiledBot } from './compile.ts';

export interface BotFile {
  readonly path: string;
  readonly label: string;
  readonly source: string;
  readonly compiled: CompiledBot;
}

export function loadBotFile(path: string): BotFile {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    throw new BotLoadError(`無法讀取選手檔案 ${path}：${(e as Error).message}`);
  }
  const label = basename(path);
  return { path, label, source, compiled: compileBot(source, label) };
}
