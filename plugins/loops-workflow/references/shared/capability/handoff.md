# Handoff — 停在使用者要求的地方，並且交接得出去

> **handoff 不是錯誤、不是取消、不是沒做完**。它的意思是「**這次被要求做的範圍已經完成**」。PM 可能只要開好 issue、架構師可能只要完成 plan、工程師可能只交 build 給 QA、QA 也可能只完成 verify——這些都是完整的交付，不是半成品。
>
> 值域（checkpoint／status／stop_reason／owner／欄位／事件／freshness 項目）的唯一真相源是
> `references/workflow-vocabulary.json` 的 `handoff` 區段；判定與事件走 `scripts/handoff-ledger.mjs`。

## 五個 checkpoint

| checkpoint | 標籤 | 做完哪個 phase 之後 | 適合誰接手 | 下一個入口 |
|---|---|---|---|---|
| `issue` | H1 · Issue Ready | define | PM／產品負責人 | `issue`（從 plan 起跑） |
| `plan` | H2 · Plan Ready | plan | 架構／規劃 | `approved-plan`（從 build 起跑） |
| `build` | H3 · Build Ready | build | QA／reviewer | `verify-only` |
| `verified` | H4 · Verified | verify | repo owner | `approved-plan`（有 finding 要修就回 build） |
| `finalized` | H5 · Delivery Ready | finalize | repo owner | —（終點） |
| `research-finalized` | H5R · Research Finalized | finalize | repo owner | `no-issue`（要實作就 define 開票） |

**H3 是「build scope 已完成、verify 尚待執行」**——不得把「尚未 verify」寫成「已通過」。這是最容易在交接文件裡出錯的一句話。

## `stop_after`：怎麼決定停在哪

`dispatch` 從使用者意圖解析，使用者也能明講。優先序：**明講的 > 意圖字面 > 入口預設**。

| 使用者意圖 | `stop_after` |
|---|---|
| 先開 issue | `issue` |
| 規劃 issue | `plan` |
| 照 approved plan 實作、交 QA | `build` |
| 只驗 PR／改動 | `verified` |
| 完成 issue／處理完 PR comment | `finalized` |
| 完成研究報告 | `research-finalized` |

規則：

- **不在每個 checkpoint 重問「要不要繼續」**——那正是 routine 轉場不問的同一條紀律。
- 到達 `stop_after` **必須停止**。`auto` 模式也不得跨越使用者指定的 handoff（安全停仍照舊）。
- 沒有明確 partial intent 時，才用該入口的安全預設終點。
- 到達之後，下一階段的任何 mutating action 都會被擋住，直到收到明確 resume。

## 停下來要做的三件事（順序不可換）

1. 寫 handoff contract → `handoff.created` 事件。
2. 產人類可讀的交接文件 `.loops/<slug>/handoff/<checkpoint>.md`（`handoff-note@1`，骨架見 artifact 模板）。
3. 記 `workflow.paused`。

**`handoff.created` 成功之後才可以寫 `workflow.paused`**——反過來的話，中間崩掉會留下一個「停住了、但沒有交接內容」的狀態：下一位既不知道做完了什麼，也不知道該從哪裡續。

## resume：先驗 freshness，再決定重跑哪一段

接手時跑四項檢查，每項只有 `pass`／`fail`／`not_measured` 三種結果——**量不到不算通過**：

| 檢查 | 比對什麼 | 失敗時最早受影響的階段 |
|---|---|---|
| `source-revision` | handoff 記的來源版本 vs 現況 | build |
| `goal-revision` | Goal Contract 有沒有在交接後改版 | plan |
| `artifact-validity` | handoff 列的產物是否還在、還對得上 | build |
| `pending-work` | pending 清單是否仍成立 | build |

- 四項全 pass ⇒ `fresh`：**直接從下一個入口續跑，不重跑已完成階段**。
- 有 fail ⇒ `stale`：只失效受影響的 decisions／artifacts／knowledge claims，**回到最早受影響的那一個階段**，不整條重跑。
- 沒有 fail、但有 `not_measured` ⇒ `uncertain`：保守退到最早受影響的階段。沒查過就當作沒問題，正是「新 session 靜默重跑錯東西」的來源。

**「換了一個 session」本身不是重跑的理由**。要重跑得說得出是哪一項 freshness 沒過。

## 舊 loop

`.loops` 不回填、不改寫，只維持讀取與 resume 相容。舊 loop 沒有 handoff 事件時，`activePause()` 回「未暫停」，一切照舊——新機制對它們完全不生效。

## Red Flags

- 到了使用者指定的 checkpoint 還繼續往下做（建 worktree、進 plan、開始 build）。
- 在每個 checkpoint 停下來問「要不要繼續」。
- 先寫 `workflow.paused` 才補 `handoff.created`。
- handoff 的 `completed` 是空的，卻宣稱 `ready`——說不出完成了什麼就不是完成。
- 交接文件自己發明格式（那會讓下一位每次都要重新讀懂一種新排版）。
- resume 時因為「這是新 session」就重新 define／重新探索／重新規劃。
- freshness 沒實際查就寫成通過。
