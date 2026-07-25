# auto 推進模式（opt-in Open Loop）（負向 fixture：已移除安全停硬煞車段落與對照表）

> 這是 `references/auto-mode.md` 的節錄變體，唯一差異：拿掉「這些情況一定停（auto 的硬煞車）」
> 整段、以及對照表的「安全停點」列，用來驗證 test-safe-stop-assertion.mjs 在規則消失時必須變紅。

## 怎麼開

- **環境變數 `LOOPS_AUTO=1`**（與 `LOOPS_STOP_GATE` 等 opt-in flag 同慣例、手動設定）—— dispatch 建 loop.md 前用 Bash `echo "${LOOPS_AUTO:-}"` 檢查，輸出 `1` → 整個 run 走 auto。
- 或在 `loop.md` 把 `推進模式` 設為 `auto`（既有 loop 續跑時改）。

## auto 模式做什麼

核准計畫後，主線自動依序跑 `build → verify → iterate`，一路到底不再停下等人確認任何事。

## 預設（決策點停）與 auto 的關係

| | 預設（決策點停） | auto（opt-in） |
|---|---|---|
| routine 轉場（進下一階段） | 不問、直接往下 | 不問、直接往下 |
| 停下問你（開一個決策點） | 真決策：選方法 / 拍板 / 完工 or 回環 / scope 取捨 | 不問（用推薦選項自動帶過） |
| 核准點 | 每個決策一次 | 計畫拍板一次 |
| 適用 | 預設、要在關鍵決策把關 | 信任計畫、要一路跑完省來回 |

> 設計取捨：auto 把所有確認 gate 都收斂掉，一路跑完。預設關閉，使用者明確要才開。
