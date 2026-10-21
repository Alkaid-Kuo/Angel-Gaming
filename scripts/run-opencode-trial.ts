// 軍備競賽試跑執行器（opencode CLI 版）：依「軍備競賽執行手冊」的執行流程，
// 送出標準提示詞；AI 在時限前停止時送出標準續行提示（最多 3 次）；時限到即終止。
// 用法：node scripts/run-opencode-trial.ts <工作資料夾> <提示詞檔> <時限分鐘> <紀錄檔> <opencode 設定檔> <模型 provider/model>
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const [runDir, promptFile, minutesArg, logFile, configFile, model] = process.argv.slice(2);
if (model === undefined) {
  process.stderr.write('用法：node scripts/run-opencode-trial.ts <工作資料夾> <提示詞檔> <時限分鐘> <紀錄檔> <opencode 設定檔> <模型>\n');
  process.exit(1);
}
const OPENCODE = process.env.OPENCODE_BIN ?? 'C:\\LocalLLM\\opencode\\opencode.exe';
const MAX_CONTINUATIONS = 3;
const limitMs = Number(minutesArg) * 60_000;
const start = Date.now();
const deadline = start + limitMs;

function log(text: string): void {
  appendFileSync(logFile, text);
}

function stamp(): string {
  return new Date().toLocaleTimeString('zh-TW', { hour12: false });
}

function runOnce(message: string, cont: boolean): Promise<number | null> {
  // --dir 與 PWD 都指向工作資料夾：opencode 以 PWD 判斷專案目錄，不能只靠 spawn 的 cwd
  const args = ['run', '--dir', runDir, '--print-logs', '--log-level', 'INFO', '--auto', '-m', model];
  if (cont) args.push('--continue');
  args.push(message);
  log(`\n===== [${stamp()}] ${cont ? '續行' : '開始'}：${message.slice(0, 80)}\n`);
  return new Promise((resolve) => {
    // 標準輸入必須關閉：opencode run 在非 TTY 時會等待標準輸入結束
    const child = spawn(OPENCODE, args, { cwd: runDir, env: { ...process.env, OPENCODE_CONFIG: configFile, PWD: runDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => log(d.toString()));
    child.stderr.on('data', (d: Buffer) => log(d.toString()));
    const remain = deadline - Date.now();
    const timer = setTimeout(() => {
      log(`\n===== [${stamp()}] 時限到，終止\n`);
      if (child.pid !== undefined) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
    }, Math.max(0, remain));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const hhmm = (t: number): string => new Date(t).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
// 提示詞中的 {開始時間}、{結束時間} 於實際開始時填入
const prompt = readFileSync(promptFile, 'utf8').replaceAll('{開始時間}', hhmm(start)).replaceAll('{結束時間}', hhmm(deadline));
let continuations = 0;
let code = await runOnce(prompt, false);
while (Date.now() < deadline - 60_000 && continuations < MAX_CONTINUATIONS) {
  const leftMin = Math.round((deadline - Date.now()) / 60_000);
  continuations += 1;
  code = await runOnce(`時間還剩 ${leftMin} 分鐘，請繼續改進並保存新版本。`, true);
}
log(`\n===== [${stamp()}] 結束：實際耗時 ${Math.round((Date.now() - start) / 60_000)} 分鐘、續行提示 ${continuations} 次、最後結束碼 ${code}\n`);
