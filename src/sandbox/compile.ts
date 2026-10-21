// 選手模組編譯：檢查（ES2020、不可 import、≤ 200 KB、default export），再轉成「每次呼叫產生全新模組作用域」的工廠函式。
// 選手程式看到的 Math.random、Date、performance 等為呼叫即拋例外的替身；這是防呆而非安全邊界。
import { parse, type Node } from 'acorn';
import type { Bot } from '../api/types.ts';
import { RULES } from '../config/index.ts';

export class BotLoadError extends Error {}

export interface CompiledBot {
  /** 每次呼叫回傳新的選手類別（模組層級變數不跨實例共用） */
  readonly createClass: () => new () => Bot;
  readonly sizeBytes: number;
}

interface AnyNode extends Node {
  [key: string]: unknown;
}

function walk(node: AnyNode, visit: (n: AnyNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c !== null && typeof c === 'object' && typeof (c as AnyNode).type === 'string') walk(c as AnyNode, visit);
    } else if (v !== null && typeof v === 'object' && typeof (v as AnyNode).type === 'string') {
      walk(v as AnyNode, visit);
    }
  }
}

/** 替身：呼叫或建構即拋例外 */
function forbidden(name: string): () => never {
  return () => {
    throw new Error(`選手禁止使用 ${name}（請使用 helpers.random()）`);
  };
}

const forbiddenDate = forbidden('Date');
Object.defineProperty(forbiddenDate, 'now', { value: forbidden('Date.now') });

const safeMath: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(Math)) {
  safeMath[key] = (Math as unknown as Record<string, unknown>)[key];
}
safeMath.random = forbidden('Math.random');
Object.freeze(safeMath);

const SHADOWED: readonly [string, unknown][] = [
  ['Math', safeMath],
  ['Date', forbiddenDate],
  ['performance', Object.freeze({ now: forbidden('performance.now') })],
  ['process', undefined],
  ['require', undefined],
  ['module', undefined],
  ['globalThis', undefined],
  ['global', undefined],
  ['window', undefined],
  ['self', undefined],
  ['setTimeout', undefined],
  ['setInterval', undefined],
  ['setImmediate', undefined],
  ['queueMicrotask', undefined],
  ['fetch', undefined],
  ['XMLHttpRequest', undefined],
  ['WebSocket', undefined],
  ['Worker', undefined],
  ['crypto', undefined],
];

/** 編譯選手原始碼；違反選手模組限制時拋出 BotLoadError */
export function compileBot(source: string, label: string): CompiledBot {
  const sizeBytes = new TextEncoder().encode(source).length;
  if (sizeBytes > RULES.botModule.maxBytes) {
    throw new BotLoadError(`${label}：檔案 ${sizeBytes} bytes 超過上限 ${RULES.botModule.maxBytes}`);
  }
  let ast: AnyNode;
  try {
    ast = parse(source, { ecmaVersion: 2020, sourceType: 'module' }) as unknown as AnyNode;
  } catch (e) {
    throw new BotLoadError(`${label}：不是合法的 ES2020 模組（${(e as Error).message}）`);
  }
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration' || n.type === 'ImportExpression') throw new BotLoadError(`${label}：選手模組不可 import`);
    if (n.type === 'MetaProperty') throw new BotLoadError(`${label}：選手模組不可使用 import.meta`);
    if (n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source !== null)) {
      throw new BotLoadError(`${label}：選手模組不可轉出其他模組`);
    }
  });
  // 轉換：移除 export 關鍵字，default export 改為回傳值
  const body = ast.body as AnyNode[];
  const edits: { start: number; end: number; text: string }[] = [];
  let defaultName: string | null = null;
  for (const stmt of body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      if (defaultName !== null) throw new BotLoadError(`${label}：只能有一個 default export`);
      const decl = stmt.declaration as AnyNode;
      const id = decl.id as AnyNode | null | undefined;
      if ((decl.type === 'ClassDeclaration' || decl.type === 'FunctionDeclaration') && id !== null && id !== undefined) {
        defaultName = id.name as string;
        edits.push({ start: stmt.start, end: decl.start, text: '' });
      } else {
        defaultName = '__default__';
        edits.push({ start: stmt.start, end: decl.start, text: 'const __default__ = ' });
        if (decl.type === 'ClassDeclaration' || decl.type === 'FunctionDeclaration') {
          edits.push({ start: decl.end, end: decl.end, text: ';' });
        }
      }
    } else if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt.declaration as AnyNode | null;
      if (decl === null) edits.push({ start: stmt.start, end: stmt.end, text: '' });
      else edits.push({ start: stmt.start, end: decl.start, text: '' });
    }
  }
  if (defaultName === null) throw new BotLoadError(`${label}：缺少 default export（選手類別）`);
  edits.sort((a, b) => b.start - a.start);
  let code = source;
  for (const e of edits) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  code = `"use strict";\n${code}\n;return ${defaultName};`;
  let factory: (...args: unknown[]) => unknown;
  try {
    factory = new Function(...SHADOWED.map(([n]) => n), code) as (...args: unknown[]) => unknown;
  } catch (e) {
    throw new BotLoadError(`${label}：編譯失敗（${(e as Error).message}）`);
  }
  const args = SHADOWED.map(([, v]) => v);
  return {
    sizeBytes,
    createClass: () => {
      const cls = factory(...args);
      if (typeof cls !== 'function') throw new BotLoadError(`${label}：default export 必須是 class`);
      return cls as new () => Bot;
    },
  };
}
