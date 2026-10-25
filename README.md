# 天使戰隊 Angel Gaming — RTS 對戰引擎

《天使戰隊》中虛構 RTS 的 headless 對戰引擎。選手由各家 AI 撰寫的 JS Bot 擔任。

- 遊戲規則：[docs/RTS 對戰引擎與選手 API 規格書 v0.4.md](docs/RTS%20對戰引擎與選手%20API%20規格書%20v0.4.md)（v0.4 的 M3 新內容為提案；v0.3 為 M2 參賽包使用的版本）
- 實作指引：[docs/開發任務書 M0～M2.md](docs/開發任務書%20M0～M2.md)
- 規格未定義處的決定：[docs/M0 實作決策紀錄.md](docs/M0%20實作決策紀錄.md)

## 軍團戰聯賽目錄（2026-10-25 搬移更新）

遊戲、觀戰網頁與共用規則位於本專案 `C:\Claude\Sandbox\Angel-Gaming`；裁判、審查與兩位選手資料夾已集中到 `C:\Claude\Sandbox\Angel-Gaming-Legion`，詳見[聯賽目錄索引](../Angel-Gaming-Legion/README.md)。

- 現行流程：[聯賽流程與規則](docs/2026-10-24_軍團戰聯賽流程與規則.md)、[第 2 輪交接文件](docs/2026-10-25_聯賽交接文件.md)。
- 裁判操作：[Legion-Arena/README.md](../Angel-Gaming-Legion/Legion-Arena/README.md)。
- 第 2 輪提示詞：[將軍](docs/2026-10-25_第二輪選手提示詞_將軍.md)、[元帥](docs/2026-10-25_第二輪選手提示詞_元帥.md)。

依交接，第 1 輪已歸檔，第 2 輪為 `v3.x` 且尚未開賽；本批已修復信箱與工具路徑，正式驗收採依序、單 worker。開賽前仍須核對部署收據、完成服務聯測並確認雙方資源；服務尚未開賽。

## 需求

- 開發：Node 22.18 以上（直接執行 TypeScript 原始碼）
- 只跑編譯後的 CLI：Node 20 以上（先 `npm run build`）

```bash
npm install
```

## 常用指令

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm run sim -- match --mode 1v1 --bots bots/baseline.js bots/random.js --games 10 --seed 1
```

```bash
npm run sim -- bench --mode 1v1
```

```bash
npm run sim -- mapgen --mode ffa4 --seed 7
```

## 瀏覽器版：人類對戰、觀戰、回放播放器

```bash
npm run web
```

啟動後開 <http://localhost:5173/web/>。第一次玩建議先跑首頁的「新手教學」。可選 1v1／4 人／8 人對基準 Bot、觀戰 Bot 對戰，或載入回放檔。規則、兵種、建築與操作說明在首頁，遊戲中按 ? 也能打開。觀戰與回放有自動導播、事件字幕、戰力曲線、精華模式、跳到下一次交戰、直接看結果。打包成靜態網頁用 `npm run build:web`（輸出到 `dist-web/`）。

用手機或同一個 Wi-Fi 的其他電腦玩：先 `npm run build:web`，再執行下面的指令，打開畫面上列出的區網網址（例如 `http://192.168.x.x:8000/web/index.html`）。只提供建置好的靜態檔案；第一次執行時 Windows 防火牆可能會詢問，要允許 Node.js 連線。

```bash
npm run serve:lan
```

## 軍團戰（原型）

取代 RTS 的新電競項目：雙方 AI 各用 500 點選兵、在看不到對手的情況下布陣，開場就行軍接敵。規則見 [docs/軍團戰 規格書 v0.1（草案）.md](docs/軍團戰%20規格書%20v0.1（草案）.md)，原型實作與量測結果見 [docs/2026-10-22_軍團戰原型報告.md](docs/2026-10-22_軍團戰原型報告.md)。

觀戰：`npm run web` 後開 <http://localhost:5173/web/legion.html>（首頁也有入口），選雙方 AI（鐵壁推進、林中伏兵、箭雨）與模式（殲滅戰、佔點）。

批次量測（勝率、時長、觀賞性指標、模擬速度）：

```bash
node scripts/legion-bench.ts 10 both
```

## 軍備競賽工具（M2）

```bash
npm run pack:build
```

產生參賽包到 `out/pack/`（規格書、基準 Bot、範例模板、CLI、回放播放器）。試跑與評測：`scripts/run-opencode-trial.ts`（opencode 版執行器）、`scripts/evaluate-trials.ts`（合規、對基準 Bot、風格統計、版本線、循環賽）、`scripts/watchability.ts`（觀賞性指標：交戰次數、平靜比例、領先易手）。M2 試跑作品在 `arms-race/2026-10-22_M2試跑/`，精選回放在 `arms-race/2026-10-22_M3精選回放/`。

## CLI：rts-sim

| 子指令 | 參數 | 說明 |
| --- | --- | --- |
| match | `--mode 1v1\|ffa4\|ffa8 --bots a.js b.js [...] [--games N] [--seed S] [--swap] [--knobs JSON] [--exec official\|batch] [--replay-dir D] [--out F]` | 指定選手對戰 N 場；第 i 場 seed = S + i；預設正式模式 |
| roundrobin | `--mode --bots a.js b.js ... [--games 每組場數] [--seed S] [--knobs JSON] [--exec]` | 循環賽：勝率矩陣與 Elo |
| viewer | `[--port 8000]` | 以本機伺服器開啟回放播放器（需先 `npm run build:web`） |
| mapgen | `--mode [--seed S] [--format ascii\|png] [--validate N] [--out F]` | 輸出 ASCII 或 PNG 地圖，或驗證 N 個 seed |
| bench | `--mode [--games N] [--exec batch] [--bot F] [--out F]` | 基準 Bot 鏡像對戰，回報每秒場數與每秒 tick |

結束碼：0 成功、1 參數錯誤、2 選手載入失敗、3 引擎內部錯誤。

ASCII 地圖圖例：`.` 平地、`#` 阻擋、`f` 樹林、`m` 礦點、`R` 富礦點、`0`～`3` 起點主堡、`W` 瞭望塔。

## 目錄

| 路徑 | 內容 |
| --- | --- |
| `src/config` | 所有數值與常數（單一設定檔） |
| `src/core` | 遊戲狀態、tick 更新、指令、事件、勝負（禁用非確定性 API） |
| `src/path` | A\* 尋路、路徑平滑、路徑快取 |
| `src/mapgen` | 程序生成地圖與驗證 |
| `src/sandbox` | 選手載入、批次／正式模式、輔助工具 |
| `src/replay` | 回放紀錄與重建 |
| `src/cli` | `rts-sim` |
| `src/view` | 繪圖用的唯讀快照 |
| `src/web` | 瀏覽器介面（Canvas 2D）與引擎 Worker |
| `web/` | 網頁入口 index.html 與樣式 |
| `src/api/types.ts` | 選手 API 公開型別 |
| `src/legion` | 軍團戰引擎（地圖、模擬、尋路、選手 API 型別、比賽驅動與回放） |
| `src/web/legion` | 軍團戰觀戰頁（Canvas 繪製、轉播介面、自動解說、引擎 Worker） |
| `bots/legion-*.js` | 軍團戰基準 AI：鐵壁推進、林中伏兵、箭雨 |
| `bots/` | 基準 Bot、隨機 Bot |
| `test/` | Vitest 測試 |
