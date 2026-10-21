# 天使戰隊 Angel Gaming — RTS 對戰引擎

《天使戰隊》中虛構 RTS 的 headless 對戰引擎。選手由各家 AI 撰寫的 JS Bot 擔任。

- 遊戲規則：[docs/RTS 對戰引擎與選手 API 規格書 v0.2.md](docs/RTS%20對戰引擎與選手%20API%20規格書%20v0.2.md)
- 實作指引：[docs/開發任務書 M0～M2.md](docs/開發任務書%20M0～M2.md)
- 規格未定義處的決定：[docs/M0 實作決策紀錄.md](docs/M0%20實作決策紀錄.md)

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

## CLI：rts-sim

| 子指令 | 參數 | 說明 |
| --- | --- | --- |
| match | `--mode 1v1\|ffa4 --bots a.js b.js [...] [--games N] [--seed S] [--exec official\|batch] [--replay-dir D] [--out F]` | 指定選手對戰 N 場；第 i 場 seed = S + i；預設正式模式 |
| mapgen | `--mode [--seed S] [--format ascii] [--validate N] [--out F]` | 印出 ASCII 地圖，或驗證 N 個 seed |
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
| `src/api/types.ts` | 選手 API 公開型別 |
| `bots/` | 基準 Bot、隨機 Bot |
| `test/` | Vitest 測試 |
