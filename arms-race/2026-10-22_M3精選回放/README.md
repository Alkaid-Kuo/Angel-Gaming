# M3 精選回放

引擎 0.3.0（規格書 v0.4）錄製，需要 `feature/m3-spectator` 以後的版本播放。用法：`npm run web` → 首頁「回放播放器」→ 選檔案。

選手是 M2 試跑的四隻作品：SpeedRush（Claude Opus 速攻）、Expander（Claude Opus 快速擴張）、Blitz（Claude Sonnet 速攻）、QuickExpand（Claude Sonnet 快速擴張）。1v1 從各組 40 場中挑「領先易手最多、勝方曾大幅落後」的場次。

| 檔案 | 對戰 | 結果 | 看點 |
| --- | --- | --- | --- |
| 01 | SpeedRush vs QuickExpand | QuickExpand 時限勝 | 領先易手 4 次、10 次交戰 |
| 02 | Expander vs SpeedRush | Expander 時限勝 | 領先易手 4 次 |
| 03 | SpeedRush vs Expander | SpeedRush 時限勝 | 領先易手 4 次 |
| 04 | Expander vs Blitz | Expander 勝（5600 tick） | 9 次交戰 |
| 05 | SpeedRush vs QuickExpand | QuickExpand 時限勝 | 12 次交戰 |
| 06 | SpeedRush vs Blitz | SpeedRush 勝（5178 tick） | 速攻對速攻 |
| 07 | QuickExpand vs Expander | QuickExpand 時限勝 | 擴張對擴張 |
| 08 | Expander vs QuickExpand | QuickExpand 時限勝 | 擴張對擴張 |
| 09 | 4 人局：四隻 AI | QuickExpand 第 1（時限） | 兩家被淘汰 |
| 10 | 8 人局：四隻 AI ＋ 四隻基準 Bot | Expander 第 1（時限） | QuickExpand 第 2 個出局 |

時限勝的場次多半靠資產分數決定（大量防禦塔），這是 M2 試跑報告列出的平衡問題。
