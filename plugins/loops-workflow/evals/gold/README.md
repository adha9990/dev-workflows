# 金標集（gold corpus）— explanation-quality

eval-judge 校準用的金標集。dimension = `explanation-quality`（rubric 見 `references/eval-judge-rubric.md`，scale 1–5、threshold=4 才 pass）。

## ⚠️ Metric-Honesty（最重要，先讀）

**這是 self-annotated baseline，不是獨立人工金標。** `explanation-quality.json` 的 `goldScore`/`goldPass` 由 **LLM 套 rubric 標註**，**不是**人類獨立判斷。下方的 κ 量的是 **inter-LLM 一致性**（gold-annotator 一個 LLM pass vs 獨立 judge-fleet 另一組 LLM pass），**不是** #33 原意的「judge vs 人工」校準。

- 兩軌都是 LLM 套同一份 rubric → 高一致是**預期**，**不代表 judge 已被人類驗證可信**。
- **真人工金標**（人類獨立標 50–100 筆）是唯一不可由 LLM 自主完成的步驟 → 留為 **operational 交接**（見下「升級到真人工金標」）。
- κ 是估算、非確定性權威；金標品質決定校準可信度（rubric 反偏誤紀律）。

## 檔案
| 檔 | 內容 |
|---|---|
| `explanation-quality.json` | 62 筆金標：6 筆 `synthetic-anchor`（抽象校準錨，artifactRef=null）+ 56 筆 `self-annotated-baseline`（真實 commit 訊息 artifact）。每筆 `{id, dimension, artifactRef, goldPass, goldScore, note, provenance}`。 |
| `artifacts/explanation-quality.json` | artifact 文字快照 `[{id, source, text}]`（56 筆真實 commit 訊息：dev-workflows 42 + eagle-app-core 14，self-contained、judge 與 re-run 都讀此份）。 |

## provenance 分類（機讀，Metric-Honesty 可審）
- `synthetic-anchor`（6）：#33 的抽象代表性範例，跨 1–5 分譜，當校準錨；無真 artifact、不進 κ 配對。
- `self-annotated-baseline`（56）：真實 commit 訊息 artifact，LLM 套 rubric 標。**非人工金標。**

## κ demo 結果（歷史紀錄）
2026-06 曾以獨立盲標 judge-fleet 軌（`judge-results-demo.jsonl`，55 筆、3 段非重疊盲標）對本金標集跑 `eval-poll kappa`：
→ **κ = 0.845（strong）**、po=0.945、pe=0.647、paired=55、unmatched=0。
該 demo 軌為一次性材料、已於 #95 清理（git 史可回收）；要重跑需自行產生新的 judge-results jsonl（`eval-poll kappa --records <你的軌> --gold plugins/loops-workflow/evals/gold/explanation-quality.json`）。

**怎麼讀（精確）**：gold-annotator（一個 blind agent pass，全 56 筆）與 judge-fleet（**三個獨立 blind agent context**、`fleet-judge-1/2/3` 分三段非重疊盲標、共 55 筆）對「pass/fail（score≥4）」的一致性。**這些 agent 都是同一 opus 模型家族、不同 agent context（盲標、看不到 gold）——是「獨立 context」不是「不同模型」。** κ 0.845 證明 **(a) pipeline 端到端可跑、(b) rubric 在獨立 blind agent pass 之間應用一致**（同模型家族、**非**跨不同模型穩定性、**非** judge 對齊人類）。pairJudgeVsGold 不看 judgeId（純比 gold vs 合併 judge 軌），distinct judgeId 只是讓「三段獨立盲標」在 artifact 上可審。boundary 分歧確實存在（`eac-33f1ccea`/`eac-bf28a8bc`/`eac-75e96c05` gold=pass、judge=fail）使 κ < 1、非 trivial。

## 升級到真人工金標（operational 交接，唯一待人類步驟）
1. 由人類（非 LLM）對 `artifacts/explanation-quality.json` 的 artifact 獨立套 rubric 標 `goldPass/goldScore`（建議盲標、≥2 人標再取共識）。
2. 覆寫對應條目的 `provenance` 為 `human`、更新 `goldScore/goldPass/note`。
3. 重跑 `eval-poll kappa`（judge-fleet vs **人工** gold）→ 得**真校準 κ**（中 κ>0.6 / 強 >0.8）。
4. 此時 κ 才是「judge 對齊人類」的可信度指標。

## 如何擴充
- 加 artifact：append 進 `artifacts/explanation-quality.json`（`{id, source, text}`）。
- 加金標：append 進 `explanation-quality.json`（同 schema + `provenance`）。
- artifact `text` 為快照（從真實 commit/PR/explain 取），讓 judge 與 re-run 不依賴外部狀態。
