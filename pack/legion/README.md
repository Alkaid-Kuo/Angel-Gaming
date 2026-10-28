# 軍團戰 選手開發包

## 任務

寫出最強的**軍團戰 AI 選手**（bot）。

- 交付物是**單一 JavaScript 檔**（例如 `my-bot.js`），必須通過沙盒檢查（`node match.ts --check my-bot.js` 顯示「通過」）。
- 比賽是**三場制**：第一場攻城戰（石關城）甲攻乙守、第二場攻城戰交換座位（乙攻甲守）、第三場佔點（大河谷或大草原輪替）；三場先取兩勝。
- **兩種模式、三張地圖**都要能贏包裡的三隻陪練對手：攻城戰 `siege`（石關城，**攻方、守方都要贏**）、佔點 `capture`（大河谷、大草原）。陪練：`bots/legion-push.js`、`bots/legion-ambush.js`、`bots/legion-ranged.js`（它們是攻城戰加入前寫的，不會用雲梯、衝車、砲擊與城門）。
- 最終評測還會加入**你沒看過的對手**。陪練只是練習對象，你的選手要能應付各種兵力組成與打法，不能只針對這三隻。
- 衡量強度時請看雙方交換起點（藍方／紅方）、多個種子的對戰結果，不要只看單場。

規則的唯一依據是 `spec.md`（選手規格書）。這個包只提供規則、引擎與工具，怎麼打由你自己研究、實驗。

## 環境

- Node.js **22.18 以上**（直接執行 `.ts`，不需要編譯，也不需要 `npm install`；需要的套件 `acorn` 已放在 `node_modules/`）。
- 所有指令都在包的根目錄執行。

## 內容

| 路徑 | 說明 |
| --- | --- |
| `spec.md` | 選手規格書：完整規則與選手 API（唯一依據） |
| `datasheet.md` | 數值總表（由引擎數值產生的速查表；與 `spec.md` 不一致時以 `spec.md` 為準） |
| `bots/template.js` | 空白範本：最小的合法選手，示範介面，不含戰術。從這裡開始 |
| `bots/legion-push.js`、`bots/legion-ambush.js`、`bots/legion-ranged.js` | 三隻陪練對手 |
| `match.ts` | 對戰工具：兩隻選手對打多場，印出勝負與基本統計；`--check` 檢查選手是否合法 |
| `trace.ts` | 文字追蹤工具：跑一場，定時印出每一團的狀態與事件（除錯用） |
| `src/` | 引擎原始碼（模擬、地圖、沙盒），只含軍團戰執行需要的檔案（少數檔案的型別引用了沒附上的舊引擎檔案，不影響執行）。評測使用原版引擎，**請不要修改** |
| `versions/` | 請把每個版本的快照存成 `versions/v1.js`、`versions/v2.js`… |
| `CHANGELOG.md` | 每個版本一行（格式見下） |
| `BUGS.md` | 發現的引擎漏洞或規格不清之處 |

## 開始

```bash
cp bots/template.js my-bot.js
node match.ts --check my-bot.js
node match.ts my-bot.js bots/legion-push.js --games 4
```

## 常用指令

**檢查選手**（載入、`declare()`、三張地圖兩個座位的布陣、自己打自己 30 秒的 `decide`）：

```bash
node match.ts --check my-bot.js
```

**對戰**（`--games` 是總場數；同一個種子雙方交換起點各打一場，所以建議用偶數）：

```bash
node match.ts my-bot.js bots/legion-push.js --mode siege --games 10 --seed 1   # 攻城戰：交換座位＝攻守互換
node match.ts my-bot.js bots/legion-ranged.js --mode capture --map grassland --games 10
node match.ts my-bot.js bots/legion-ambush.js            # 預設三組（攻城戰石關城、佔點大河谷、佔點大草原）各 2 場
```

| 參數 | 說明 |
| --- | --- |
| `--mode siege\|capture\|both` | 模式（預設 both：攻城戰與佔點） |
| `--map 地圖id` | 只跑這張地圖：`stone-pass`（攻城戰）、`grand-valley`、`grassland`（佔點） |
| `--games N` | 每組（模式、地圖）的總場數（預設 2） |
| `--seed S` | 起始種子（預設 1）；第 1、2 場用 S，第 3、4 場用 S＋1，依此類推 |
| `--knobs-a '{"key":值}'`、`--knobs-b …` | 指定 A、B 的旋鈕值（沒指定的用 default） |
| `--quiet` | 只印每組的小計 |
| `--json` | 改輸出 JSON（每場的明細與小計） |

輸出：每場一行（種子、A 坐哪一方、勝負、結束原因、時間、雙方戰果；佔點另有分數、攻城戰另標 A 是攻方還是守方），以及每組的小計（勝敗平、勝率、結束原因、平均時間、平均戰果與分數、攻城戰 A 當攻方與守方各自的戰績、雙方 `decide` 耗時、例外、逾時、被拒絕的布陣與指令數）。

結束碼：0 成功、1 參數錯誤、2 選手載入失敗（`--check` 不通過也是 2）。

**追蹤一場**（上帝視角；預設攻城戰、A 坐藍方（攻方），每 10 秒印一次，事件只印重要的）：

```bash
node trace.ts my-bot.js bots/legion-push.js --seed 1 --every 10
node trace.ts my-bot.js bots/legion-push.js --swap --events all          # A 當守方
node trace.ts my-bot.js bots/legion-push.js --mode capture --map grassland --swap --side 1 --until 120
```

| 參數 | 說明 |
| --- | --- |
| `--mode`、`--map`、`--seed` | 同 match.ts（`--mode` 預設 siege） |
| `--swap` | A 改坐紅方（東側；攻城戰的守方） |
| `--every 秒` | 每幾秒印一次各團狀態（預設 10） |
| `--until 秒` | 只跑到第幾秒 |
| `--side 0\|1` | 只顯示一方的軍團與事件 |
| `--events none\|key\|all` | 事件：不印／重要事件（被拒絕的布陣與指令、衝刺撞擊、覆滅、升級、旗點、入場撤回、埋伏、城門、雲梯、衝車撞門、砲擊）／全部（另加接戰、技能） |
| `--knobs-a`、`--knobs-b` | 同 match.ts |

每團一行：方、id、兵種、位置（格）、朝向、人數、血量百分比、陣形、姿態、狀態、指令、目標、老兵等級、技能冷卻（秒）、對手是否看得到、選手設的意圖（`intent`）與幾秒前設的。攻城戰另印兩面旗、城門、雲梯、衝車與剩餘砲擊。

## 選手的要點（詳見 `spec.md`）

- 單一檔案、ES2020 模組、不可 `import`、≤ 200 KB；`export default` 一個 class，提供 `declare()`、`init()`（選填）、`deploy()`、`decide()`。
- 不能用 class 欄位語法、`??=`、數字分隔符號等 ES2021 以後的語法；亂數只能用 `helpers.random()`。
- `init`、`deploy` 上限各 1000 ms；`decide` 每 0.5 秒（5 tick）呼叫一次，上限 50 ms，**超過一次就整場不再呼叫**。
- 每次 `decide` 最多 10 個指令；指令可以附 `intent`（20 字內），用 `trace.ts` 看得到，方便除錯。
- 只看得到己方視野內的敵軍；城門、雲梯、衝車、砲擊落點（`obs.structures`）雙方都看得到。
- 攻城戰：士兵分地面與牆頂兩層（`layer`），近戰只發生在同層、射擊可以跨層；攻方有雲梯（`ladder`）、衝車（`man`）、砲擊（`bombard`），守方能開關城門（`gate`）、推倒雲梯（`topple`）。開局資料的 `data.map.features` 列出牆、城門、樓梯、隘口、高地、樹林，`data.siege` 是攻城戰的全部數值。詳見 `spec.md` 第十八章。

## 版本管理

- 每個要保留的版本存一份快照：`versions/v1.js`、`versions/v2.js`…（`declare()` 的 `version` 也跟著改）。
- `CHANGELOG.md` 每個版本一行，格式：

```text
v3 | 攻城（攻／守）push 70%/80% / ambush 60%/75% / ranged 80%/85% | 佔點（大河谷／大草原）push 65%/60% / ambush 55%/50% / ranged 75%/70% | 變更：……
```

  勝率請寫明場數與種子範圍（例如「各 20 場、種子 1～10」），讓不同版本可以比較。
- 新版本可以和舊版本對打（`node match.ts my-bot.js versions/v2.js`），確認沒有退步。

## 回報問題

- 發現引擎漏洞、規格與引擎行為不一致、或規格寫得不清楚的地方，記在 `BUGS.md`（重現方式：指令、種子、第幾秒）。
- 評測時這些漏洞可能已經修正；依賴漏洞的打法可能失效。
