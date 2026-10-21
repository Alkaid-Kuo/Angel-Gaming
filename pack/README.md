# RTS 選手開發包

你要撰寫一隻 RTS 對戰選手 Bot。規則以 `spec.md` 為準。

## 內容

| 路徑 | 說明 |
| --- | --- |
| `spec.md` | 規則與選手 API（唯一依據） |
| `bots/baseline.js` | 基準 Bot 原始碼：你的對手，也是範例 |
| `bots/template.js` | 範例模板：可直接執行的起點 |
| `rts-sim.mjs` | 模擬器 CLI（需要 Node 20 以上） |
| `viewer/` | 回放播放器（用 `rts-sim.mjs viewer` 開啟） |
| `versions/` | 請把每個版本快照存成 `versions/v1.js`、`v2.js`… |
| `CHANGELOG.md` | 每個版本一行：版本、對基準 Bot 勝率、變更內容 |
| `BUGS.md` | 發現的引擎漏洞或規格不清之處 |

## 常用指令

對基準 Bot 1v1（雙方交換起點；`--games` 是總場數，須為偶數）：

```bash
node rts-sim.mjs match --mode 1v1 --bots my-bot.js bots/baseline.js --swap --games 50 --seed 1
```

4 人局（你 vs 3 隻基準 Bot）：

```bash
node rts-sim.mjs match --mode ffa4 --bots my-bot.js bots/baseline.js bots/baseline.js bots/baseline.js --games 10 --seed 1
```

指定旋鈕值（JSON 陣列，依 `--bots` 順序；null 表示預設值）：

```bash
node rts-sim.mjs match --mode 1v1 --bots my-bot.js bots/baseline.js --swap --games 20 --knobs '[{"myKnob":3},null]'
```

循環賽（多個版本互打，輸出勝率矩陣與 Elo）：

```bash
node rts-sim.mjs roundrobin --mode 1v1 --bots versions/v1.js versions/v2.js my-bot.js --games 10 --seed 1
```

存回放並在瀏覽器觀看：

```bash
node rts-sim.mjs match --mode 1v1 --bots my-bot.js bots/baseline.js --games 2 --seed 1 --replay-dir replays
```

```bash
node rts-sim.mjs viewer
```

開啟印出的網址，選「回放播放器」載入 `replays/` 裡的檔案。

看地圖（ASCII 或 PNG）：

```bash
node rts-sim.mjs mapgen --mode 1v1 --seed 5
```

## 執行模式

- `--exec official`（預設）：每位選手在獨立 Worker 執行並計時（decide 軟上限 5 ms、硬上限 50 ms）。評測一律使用這個模式。
- `--exec batch`：同一執行緒、不計軟上限，速度快很多，適合大量迭代；但**無法中斷無窮迴圈**。

## 輸出

`match` 輸出 JSON：

- `summary.bots[]`：各選手的場數、勝場、`winRate`（1v1）或平均名次（4 人局）。
- `games[]`：每場的 seed、長度（tick）、每位選手的名次、資產分數與統計：
  - `gathered`、`unitsProducedByType`、`unitsLost`、`kills`、`buildingsBuiltByType`
  - `firstExpansionTick`、`firstDamageTick`、`apm`、`rejections`（各拒絕原因次數）
  - `softTimeouts`、`exceptions`、`hardKilled`、`errors`（前幾筆例外訊息）
  - `towersBuilt`、`workerKills`、`productionRatio`、`scoutCount`、`towerHeldTicks`、`richGatherRatio`
  - `decideMsAvg`、`decideMsMax`（decide 耗時）

結束碼：0 成功、1 參數錯誤、2 選手載入失敗（訊息會說明原因）、3 引擎內部錯誤。
