# auto 推進模式（opt-in Open Loop）

> **預設是決策點停**（routine 轉場不問，只在真決策與安全停用 `AskUserQuestion`）。`auto` 是**可選**模式：使用者**核准一次計畫**後，連決策也用推薦選項自動帶過 —— 但**遇到危險或失敗仍會停**。這是「有保留驗證的折衷」—— 把決策 gate 也收斂掉，只保留所有危險煞車。

## 怎麼開

- **環境變數 `LOOPS_AUTO=1`**（與 `LOOPS_STOP_GATE` 等 opt-in flag 同慣例、手動設定）—— dispatch 建 loop.md 前用 Bash `echo "${LOOPS_AUTO:-}"` 檢查，輸出 `1` → 整個 run 走 auto。**注意（#99）**：`loop-driver` hook（`LOOPS_LOOP_DRIVER=1` 時的 build 機械續跑）在**每次 Stop 當下**也讀這個環境變數，且**會覆蓋 loop.md 記錄的 `closed`**——殘留的 `LOOPS_AUTO=1`（如上個 session 忘了 unset）會讓 closed loop 的 build 被意外續跑；詳見 `journaling.md` loop-driver 條目。
- 或在 `loop.md` 把 `推進模式` 設為 `auto`（既有 loop 續跑時改）。
- 也可只對某段開：plan 拍板時說「接下來 build→verify 走 auto」。

## auto 模式做什麼

核准計畫後，主線自動依序跑 `build → verify → iterate`，**每階段照樣**：寫 `.loops/` 對應 markdown、分段 commit、紅綠分離、多 reviewer fan-out。只是**不在階段之間停下等人**。

## 但這些情況**一定停**（auto 的硬煞車）

不管 auto 與否，碰到就停下問人：

1. **危險 / 不可逆操作**：改權限、搬 / 刪資料庫、付款、刪資料、任何 `git revert` 救不回來的。
2. **測試怎樣都弄不綠**（超過 build 的修補上限）。
3. **規格 / 需求講不清楚**，需要使用者拍板才能往下。
4. **verify 判 `Not ready`、iterate 回環碰到圈數軟上限**（接 `iterate` §5）—— 分三種走法，**圈數本身不是停止修正的理由**：
   - **還有未修的 P0/P1** → **不停、繼續修**（把現況：未清 P0/P1 逐條 + findings 軌跡 + 歸因 + 下一圈換什麼手法，寫進 `loop.md` Journal ＋ chat 摘要後續修；auto ≠ 靜默）。P0 另依 #5 一律停。
   - **已無 P0/P1、只剩 P2/P3** → **停下問**（沿用既有上限停損語意：收圈 / 授權再繞 / 記 out-of-scope 由使用者選）。
   - **「知情帶著未修的 P0/P1 收圈進 PR」永遠是硬煞車** → auto **不得**自動選此項，一定停下讓使用者拍板（放行已知缺陷是使用者的 scope 決策，同 #6 的知情 + 留痕精神）。
5. 任何 reviewer 報出 **P0**。
6. **用戶回饋要求的改動會反轉 / 抵觸某條已寫定的 issue AC**（見 `iterate` skill〈AC-衝突檢查〉）→ 停下用 `AskUserQuestion` 確認 informed descope。**與 #3 互補**：#3 是規格**講不清**（ambiguous）；本條是規格**清楚、卻被回饋推翻**——auto 一樣要停，讓使用者知情拍板（使用者仍有權 descope，重點是知情 + 留痕，不是攔阻）。

停下時在 `loop.md` 記一筆「auto 因 X 暫停」，等使用者處理後可續跑。

## 預設（決策點停）與 auto 的關係

| | 預設（決策點停） | auto（opt-in） |
|---|---|---|
| routine 轉場（進下一階段） | 不問、直接往下 | 不問、直接往下 |
| 停下問你（`AskUserQuestion`） | 真決策：選方法 / 拍板 / 完工 or 回環 / scope 取捨 | 不問（用推薦選項自動帶過） |
| 安全停點 | 全部（分類模糊 / 危險 / P0 / 規格不清 / 回饋反轉 AC / 帶未修 P0/P1 收圈） | 危險 / 失敗 / P0 / 規格模糊 / 回饋反轉已寫定 AC / **帶未修 P0/P1 收圈**（此項 auto 也不自動帶過） |
| 核准點 | 每個決策一次 | 計畫拍板一次 |
| 適用 | 預設、要在關鍵決策把關 | 信任計畫、要一路跑完省來回 |

> 設計取捨：auto 不是「放生亂跑」，是「把確認 gate 收斂成一次（計畫拍板）+ 保留所有危險煞車」。預設關閉，使用者明確要才開。

> 要把 auto 接到排程 / 連續跑（環境的 `/loop`·`/schedule`），見 `references/automations.md`。
