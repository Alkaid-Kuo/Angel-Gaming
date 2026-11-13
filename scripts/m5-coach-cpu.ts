// M5 規格 6.8 第 6 條「暫停時 CPU 閒置」的量測：真的 Chrome（有視窗、GPU 照常）開正式建置的教練即時頁，
// 分段量整個瀏覽器（所有 chrome 子行程）的 CPU 時間，換算成「佔一顆核心的百分比」。
// 段落：空白頁（瀏覽器底噪）→ 教練模式 1 倍速 → 教練暫停中（面板開著等指令）→ 繼續後 1 倍速（確認恢復）。
// 用法（先 npx vite build 產生 dist-web；機器要閒置，不要和大型量測並跑）：
//   node scripts/m5-coach-cpu.ts [--secs 30] [--seed 1] [--pre 60] [--bg-max 50] [--root dist-web] [--chrome <chrome.exe>] [--json out.json]
//   修前修後對照：把修前的版本 build 到另一個資料夾（npx vite build --outDir dist-web-before），用 --root 指過去。
// 量法：
// - 每段開始與結束各取一次所有屬於這個暫存設定檔的 chrome 行程的 TotalProcessorTime（PowerShell），差值 ÷ 牆鐘時間。
// - 頁面主執行緒另用 CDP Performance.getMetrics 的 TaskDuration、ScriptDuration；畫面每幀毫秒讀頁面除錯掛勾 __sg.perf()（網址帶 ?debug）。
// - 背景：開 Chrome 前先量 --pre 秒整台機器的忙碌量；每段也算「整台 − 這個 Chrome」。任何一個超過 --bg-max（佔一顆核心的 %）整次作廢。
// - 暫停那段：停畫要等畫面輸入 6.5 秒沒變（src/web/shooter/main.ts 的 IDLE_SETTLE_MS），腳本最後一次點擊後等 10 秒才開始量。
// - 不碰使用者的瀏覽器：Chrome 用新的暫存設定檔，量完關掉並刪掉暫存設定檔。localStorage 只寫在那個暫存設定檔裡。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { STAGE_NAMES } from '../src/manage/attrs.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { advance, beginMatchDay, newGame } from '../src/manage/game.ts';
import { ShooterGateway } from '../src/manage/gateway-shooter.ts';
import { SHOOTER_ENGINE_VERSION } from '../src/shooter/config.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const SECS = Number(arg('secs', '30'));
const SEED = Number(arg('seed', '1'));
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const JSON_OUT = arg('json', '');
/** 開量前先量多久的背景（秒） */
const PRE = Number(arg('pre', '60'));
/** 背景（非這個 Chrome 的行程）CPU 超過這個值（佔一顆核心的 %）就作廢 */
const BG_MAX = Number(arg('bg-max', '50'));
const ROOT = resolve(arg('root', 'dist-web'));
const CORES = cpus().length;
if (!existsSync(join(ROOT, 'web', 'shooter.html'))) throw new Error(`找不到 ${ROOT}/web/shooter.html：先跑 npx vite build`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 教練票：正式比賽日的請求單（beginMatchDay），顯示欄位照經營頁的寫法 ----
const content = SHOOTER_CONTENT;
const state = newGame(SEED, content, { gateway: new ShooterGateway() });
await advance(state, content, new ShooterGateway());
const t = beginMatchDay(state, content);
if (t === null) throw new Error('這個種子第 1 週沒有我方比賽');
const ids = [...t.lineups[0], ...t.lineups[1]];
const specs = [...t.request.a.players, ...t.request.b.players];
const pName = (id: string): string => state.players.find((p) => p.id === id)?.name ?? id;
const f = state.fixtures.find((x) => x.id === t.fixtureId);
const tName = (id: string): string => state.teams.find((x) => x.id === id)?.name ?? id;
const ticket = {
  v: 1,
  request: t.request,
  names: ids.map(pName),
  portraits: ids.map((id) => state.players.find((p) => p.id === id)?.portraitId ?? ''),
  tags: specs.map((s) => `${s.lineageId} ${STAGE_NAMES[s.version - 1] ?? `v${s.version}`}`),
  teams: [tName(f?.home ?? ''), tName(f?.away ?? '')],
  mine: t.side === 'a' ? 0 : 1,
  title: '例行賽',
  coach: { side: t.side, assistant: t.assistant, tactics: content.tactics.map((x) => ({ id: x.id, name: x.name, side: x.side, tips: x.tips })) },
  engineVersion: SHOOTER_ENGINE_VERSION,
};

// ---- 靜態伺服器（dist-web） ----
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = normalize(join(ROOT, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
  if (!p.startsWith(ROOT) || !existsSync(p) || !statSync(p).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${port}`;

// ---- Chrome（暫存設定檔、遠端除錯） ----
const profile = mkdtempSync(join(tmpdir(), 'm5-coach-cpu-'));
const DBG = 9300 + Math.floor(Math.random() * 500);
// 開量前的背景：還沒開 Chrome，整台機器的忙碌量就是背景
console.log(`量背景 ${PRE} 秒（還沒開 Chrome）…`);
const pre0 = cpuByType();
await sleep(PRE * 1000);
const pre1 = cpuByType();
const preBusy = machineBusy(pre0, pre1);
console.log(`開量前背景：${preBusy}%（佔一顆核心）`);
const chrome: ChildProcess = spawn(
  CHROME,
  [`--user-data-dir=${profile}`, `--remote-debugging-port=${DBG}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,900', '--window-position=40,40', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-extensions', 'about:blank'],
  { stdio: 'ignore' },
);

async function cleanup(): Promise<void> {
  try {
    chrome.kill();
  } catch {
    /* 已關 */
  }
  server.close();
  await sleep(1500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome 還沒放開檔案就留著（在系統暫存資料夾） */
  }
}

/**
 * 這個設定檔的所有 chrome 行程 CPU 毫秒，依行程類型加總（browser、renderer、gpu-process、utility…）；
 * 另取整台機器的處理器原始計數（PercentProcessorTime 是閒置時間，100 ns 為單位），算整台忙碌多少、扣掉 Chrome 就是背景。
 */
function cpuByType(): { at: number; byType: Record<string, number>; idle: number; sys: number } {
  const ps = `$ErrorActionPreference='SilentlyContinue'; $r=Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"; "sys\`t$($r.PercentProcessorTime)\`t$($r.Timestamp_Sys100NS)"; $t=[math]::Floor([DateTime]::UtcNow.Ticks / 10000); Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ? { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | % { $p=Get-Process -Id $_.ProcessId; $ty='browser'; if ($_.CommandLine -match '--type=([a-z-]+)') { $ty=$Matches[1] }; "$ty\`t$($p.TotalProcessorTime.TotalMilliseconds)" }; "tick\`t$t"`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const byType: Record<string, number> = {};
  let at = 0;
  let idle = 0;
  let sys = 0;
  for (const line of out.split(/\r?\n/)) {
    const [k, v, w] = line.split('\t');
    if (k === 'tick') at = Number(v);
    else if (k === 'sys') {
      idle = Number(v);
      sys = Number(w);
    } else if (k && v) byType[k] = (byType[k] ?? 0) + Number(v);
  }
  return { at, byType, idle, sys };
}

/** 兩次取樣之間整台機器的忙碌量（佔一顆核心的 %；20 核全滿＝2000%） */
function machineBusy(a: { idle: number; sys: number }, b: { idle: number; sys: number }): number {
  return Math.round((1 - (b.idle - a.idle) / (b.sys - a.sys)) * CORES * 1000) / 10;
}

// ---- CDP ----
interface Cdp {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  close: () => void;
}
async function connect(): Promise<Cdp> {
  let list: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && list.length === 0; i++) {
    try {
      list = ((await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()) as typeof list).filter((x) => x.type === 'page');
    } catch {
      /* 還沒起來 */
    }
    if (list.length === 0) await sleep(200);
  }
  if (list.length === 0) throw new Error('連不上 Chrome 遠端除錯');
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise<void>((r, j) => {
    ws.onopen = () => r();
    ws.onerror = () => j(new Error('CDP 連線失敗'));
  });
  let id = 0;
  const wait = new Map<number, { r: (v: unknown) => void; j: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (m.id === undefined) return;
    const w = wait.get(m.id);
    wait.delete(m.id);
    if (m.error) w?.j(new Error(m.error.message));
    else w?.r(m.result);
  };
  return {
    send: <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((r, j) => {
        id += 1;
        wait.set(id, { r: r as (v: unknown) => void, j });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

interface Phase {
  name: string;
  secs: number;
  /** 整個瀏覽器的 CPU（佔一顆核心的百分比），依行程類型 */
  cpu: Record<string, number>;
  total: number;
  /** 頁面主執行緒（CDP）：工作與腳本佔牆鐘的百分比 */
  mainTask: number;
  mainScript: number;
  /** 段落結束時的頁面狀態 */
  note: string;
  perf: { drawMs: number; frameMs: number; drawn: number; sleeps: number; sleeping: boolean } | null;
  /** 整台機器的忙碌量、扣掉這個 Chrome 的背景（佔一顆核心的 %） */
  machine: number;
  background: number;
}

const phases: Phase[] = [];
try {
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Performance.enable');
  const evalJs = async <T,>(expr: string): Promise<T> => ((await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value);
  const metrics = async (): Promise<Record<string, number>> => Object.fromEntries((await cdp.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

  async function measure(name: string, note: () => Promise<string>): Promise<void> {
    const m0 = await metrics();
    const c0 = cpuByType();
    await sleep(SECS * 1000);
    const c1 = cpuByType();
    const m1 = await metrics();
    const wall = (c1.at - c0.at) / 1000;
    const cpu: Record<string, number> = {};
    for (const k of new Set([...Object.keys(c0.byType), ...Object.keys(c1.byType)])) cpu[k] = Math.round((((c1.byType[k] ?? 0) - (c0.byType[k] ?? 0)) / 10 / wall) * 10) / 10;
    const total = Math.round(Object.values(cpu).reduce((a, b) => a + b, 0) * 10) / 10;
    const pct = (k: string): number => Math.round((((m1[k] ?? 0) - (m0[k] ?? 0)) / ((m1.Timestamp ?? 0) - (m0.Timestamp ?? 0) || 1)) * 1000) / 10;
    const perf = await evalJs<{ drawMs: number; frameMs: number; drawn: number; sleeps: number; sleeping: boolean } | null>('window.__sg ? (({drawMs, frameMs, drawn, sleeps, sleeping}) => ({drawMs: Math.round(drawMs*100)/100, frameMs: Math.round(frameMs*100)/100, drawn, sleeps, sleeping}))(window.__sg.perf()) : null');
    const machine = machineBusy(c0, c1);
    const background = Math.round((machine - total) * 10) / 10;
    phases.push({ name, secs: Math.round(wall * 10) / 10, cpu, total, mainTask: pct('TaskDuration'), mainScript: pct('ScriptDuration'), note: await note(), perf, machine, background });
    console.log(`${name}：整個瀏覽器 ${total}%（${Object.entries(cpu).map(([k, v]) => `${k} ${v}`).join('、')}）主執行緒 ${phases[phases.length - 1].mainTask}%；背景 ${background}%`);
  }

  const barText = (): Promise<string> => evalJs<string>(`(document.querySelector('.sg-coach')?.textContent ?? '') + ' | 面板' + (document.querySelector('.sg-coachp')?.classList.contains('hidden') === false ? '開' : '關') + ' | tick ' + (window.__sg?.frame()?.tick ?? '?')`);
  const click = (sel: string): Promise<boolean> => evalJs<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const panelOpen = (): Promise<boolean> => evalJs<boolean>(`document.querySelector('.sg-coachp')?.classList.contains('hidden') === false`);

  await sleep(3000);
  await measure('空白頁（瀏覽器底噪）', async () => 'about:blank');

  // 教練票寫進這個暫存設定檔的 localStorage，再開即時頁（不是嵌入，教練頁照樣是教練模式）
  await cdp.send('Page.navigate', { url: `${BASE}/web/shooter.html?debug` });
  await sleep(3000);
  await evalJs(`localStorage.setItem('angel-gaming-coach', ${JSON.stringify(JSON.stringify(ticket))}); true`);
  await cdp.send('Page.navigate', { url: `${BASE}/web/shooter.html?debug&m=1#coach` });
  for (let i = 0; i < 60 && !(await evalJs<boolean>('!!document.querySelector(".sg-coach button")')); i++) await sleep(500);
  if (!(await evalJs<boolean>('!!document.querySelector(".sg-coach button")'))) throw new Error(`教練列沒出現：${await barText()}`);
  await sleep(5000);
  await measure('教練模式 1 倍速', barText);

  // 暫停：本回合照打、停在下一回合開始前。先切 8 倍速讓它快點打完這回合，停住後再切回 1 倍速（停著時速度不影響推進）
  if (!(await click('.sg-coach button[data-act="cpause"]'))) throw new Error('找不到暫停鍵');
  await click('[data-act="speed"][data-i="4"]');
  for (let i = 0; i < 600 && !(await panelOpen()); i++) await sleep(500);
  if (!(await panelOpen())) throw new Error(`等不到暫停面板：${await barText()}`);
  await click('[data-act="speed"][data-i="1"]');
  // 畫面停畫要等輸入 6.5 秒沒變（main.ts 的 IDLE_SETTLE_MS），腳本剛點過按鈕，等 10 秒再量
  await sleep(10000);
  await measure('教練暫停中（面板開著等指令）', barText);

  await click('.sg-coachp [data-act="cgo"]');
  await sleep(5000);
  await measure('按繼續後 1 倍速', barText);
  cdp.close();
} finally {
  await cleanup();
}

const valid = preBusy <= BG_MAX && phases.every((p) => p.background <= BG_MAX);
const report = { seed: SEED, secs: SECS, engineVersion: SHOOTER_ENGINE_VERSION, cores: CORES, preBackground: preBusy, bgMax: BG_MAX, valid, phases };
if (!valid) console.log(`背景超過 ${BG_MAX}%（佔一顆核心），這次作廢`);
if (JSON_OUT !== '') writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
