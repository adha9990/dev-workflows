---
name: build
description: Implements each planned task via red-green-refactor with separate test-author and impl-author agents to prevent tests bending to the implementation. Use when starting the build stage of a loops-workflow run, or when a confirmed plan is ready to be coded task by task.
---

# build — 執行（紅綠分離 + Refactor）

## Overview

`build` 逐任務跑 **紅 → 綠 → 重構**，並用**兩個分離的 agent** 防止測試遷就實作：`test-author` 只看需求寫 failing test、看不到實作；`impl-author` 只負責轉綠、不准改 test。主線當編排者，不自己下海寫 test 或 impl，只接收紅綠結果。

> 為何不偏：feedback（test）與被測對象（impl）由不同 agent、在不同 context 產出 —— 寫測試的沒看過實作，就不會把測試寫成遷就實作；寫實作的不能改測試，就不能讓測試將就自己。

## When to Use

**Use when**：`02-plan.md` 已拍板、要逐任務實作。

**NOT for**：
- 計畫還沒拍板 —— 回 plan。
- 改完要驗收 —— 去 verify。

> **動 code 前先確認在 worktree 裡**：在獨立 git worktree（自帶 branch）寫，不在使用者主 checkout 直接改（dispatch 對 issue/fix 已開；純設計迴圈走到這裡才開 —— `git worktree add .claude/worktrees/<slug> -b <slug> <base>`，branch / worktree 名 = slug，不加 type 前綴）。見 `AGENTS.md` 規則 9。

## Process（每個任務跑一遍紅 → 綠 → 重構 7 步）

1. **派 `test-author`**：只給它需求 / 契約 + TDD 品質判準，**它的 context 不含 implementation**；把 `references/test-rubric.md` 的**絕對路徑**寫進其 prompt（分層測試 unit/integration/smoke/e2e、real-not-mock、async 等真完成、data-layer 覆蓋清單；subagent 用相對路徑讀不到）。它回 failing test + 「這測哪條需求」。
2. **主線跑測試 → 確認 Red**（測試如預期失敗，且失敗原因正確）。
3. **派 `impl-author`**：給它 test + plan，寫**最小實作**轉綠。**不准改 test**。
4. **主線跑測試 → 確認 Green**。
5. **Refactor**（綠燈後、test 保護下整理結構不改行為）：套 `code-simplification`（派 impl-author 時把 `references/code-simplification.md` 的**絕對路徑**寫進其 prompt —— subagent 用相對路徑讀不到，見 AGENTS.md〈參考檔路徑解析〉）—— Chesterton's Fence（改 / 刪前先答「為什麼當初這樣寫」）、過度簡化四陷阱、**紅旗「簡化若需要改 test 才能過 = 你改的是行為不是結構，停下」**。
6. **衝突仲裁**：若 impl-author 主張 test 與需求不符 → 回報主線，主線依 `00-goal.md` 完工定義裁決；必要時派 `referee` 判是 test 錯還是 impl 錯。
7. **Save Point**：測試綠 → 分段 commit（繁中、每個邏輯單位一筆，規範見 `references/commit-spec.md`）；測試紅且修不動 → revert 到上個 Save Point。寫 `03-build.md`（Change Summaries 三段式，見 `references/change-summaries.md`）。

**偏離 plan 就回去改**：實作若發現需偏離 `02-plan.md`（某決策要變、某任務要重拆）→ **先回去更新 `02-plan.md`（living plan）並同步已 post 的版本**，再續做；偏離大到動搖方案就回 `plan` gate 重新拍板。不要讓 code 與 plan 各走各的、留到最後才對。

**內部紅綠不每單位停**；整個 build 做完寫 `03-build.md` + 摘要，**直接進 verify**（routine 轉場不問）。只有碰到危險 / 不可逆操作、或測試怎樣都弄不綠時才停下用 `AskUserQuestion` 問。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接自己寫 test 和 impl 比較快」 | 同一個腦袋寫兩邊，test 會不自覺遷就 impl，錯的東西會一路綠燈。分離才有真 feedback。 |
| 「test 跟我實作對不上，改一下 test 就過了」 | 改 test 遷就 impl 正是要防的事。除非 referee 裁定 test 錯，否則改 impl。 |
| 「Refactor 改一改，順手調個 test」 | 簡化需要改 test = 你改了行為，不是重構。停下，這要走衝突仲裁或回 plan。 |
| 「全部寫完一次 commit」 | 分段 commit 才有 Save Point；一次大 commit 失敗時無處可 revert。 |

## Red Flags

- 主線自己寫 test 或 impl（沒派 agent）。
- test-author 的 context 裡出現了 implementation。
- impl-author 改了 test 來轉綠。
- Refactor 階段測試行為被改動。
- build 做到一半沒紅綠軌跡就 commit。

## Verification

- [ ] 每個任務都有「Red 確認 → Green 確認」軌跡記在 `03-build.md`。
- [ ] test 由 test-author 在無 impl context 下產出；impl 由 impl-author 產出且未改 test。
- [ ] Refactor 後測試行為未變（仍綠）。
- [ ] 分段 commit（繁中）對應各 Save Point。
- [ ] `03-build.md` 有 Change Summaries 三段式。
- [ ] 實作若偏離 plan，`02-plan.md` 已回去同步更新（as-built），未留到最後。
- [ ] 依 `references/docs-policy.md` 判斷是否需補 `docs/<topic>.md`（+ `docs/README.md` 索引）；命中就寫。
- [ ] build 做完寫 `03-build.md` 並進 verify（無危險 / 卡關才停），沒用純文字問「要不要進 verify」。
