<!-- loops-artifact: validation-report@1 -->
# 雙 harness E2E 證據表

> 七個關鍵步驟 × 兩個平台的實測狀態總表。每格只填兩種值：`pass`（有指向實際測試檔或真實樣本的證據）或 `not_measured`（附一段可直接執行的重播指令，講清楚要驗什麼、預期會看到什麼）。**兩個平台的結果分開列，不合併也不取平均**——一個平台已驗證，不代表另一個平台也驗證過。

## 七個步驟

1. dispatch 分類並建立 / resume loop
2. 真正決策點出現結構化選項
3. guard 能阻擋錯誤落點
4. file edit guard 能看見平台實際 edit payload
5. subagent persona 可被平台載入或由 adapter 正確派出
6. Stop／progress hook 不因輸出 schema 或並行順序失效
7. 同一 fixture 產生等價的 canonical state transition

## Claude 平台

| # | 步驟 | status | 證據 |
|---|---|---|---|
| 1 | dispatch 分類並建立/resume loop | pass | 真實 live-capture／real-pr 樣本：`plugins/loops-workflow/evals/baseline/corpus/route-slug-resume.json`（既有 slug 走 resume）、`route-no-issue-define.json`、`route-pr-review-verify.json`、`route-rule-change-maintainer.json`（皆為對照 dispatch 分類公式的真實重播，經 `node plugins/loops-workflow/scripts/baseline-corpus.mjs` 判過）；入口單一性契約：`plugins/loops-workflow/scripts/test-canonical-contracts.mjs`（A 段，23 條斷言全綠）。 |
| 2 | 真正決策點出現結構化選項 | pass | 真實歷史高風險情境：`plugins/loops-workflow/evals/baseline/corpus/high-risk-182-safe-stop.json`（real-loop provenance，記錄了一次真實撞到安全停、停下讓人決定的事件，並驗證停下後有老實走完後續全部階段，非跳關）；互動層契約 `plugins/loops-workflow/references/shared/delivery/interaction-adapter.md` §3 對應到本平台的結構化提問能力。 |
| 3 | guard 能阻擋錯誤落點 | pass | `plugins/loops-workflow/hooks/test-worktree-guard.mjs`（49 條斷言全綠，真實 deny 判定：對已建 loop 分支的主 checkout 建立動作）＋ `plugins/loops-workflow/hooks/test-path-guard.mjs`（63 條斷言全綠，真實 deny 判定：寫入路徑落在受管目錄）。 |
| 4 | file edit guard 能看見平台實際 edit payload | pass | `plugins/loops-workflow/hooks/test-config-protection.mjs`（10 條斷言全綠，C1/C2 為本平台真實 `tool_input.file_path` 形狀 payload 的 deny/allow 判定，真 spawn 被測 hook）；真實歷史 bug-fix 樣本：`plugins/loops-workflow/evals/baseline/corpus/quality-bug-130-guard-matcher.json`。 |
| 5 | subagent persona 可被平台載入或由 adapter 正確派出 | pass | `plugins/loops-workflow/scripts/test-gen-reviewers.mjs`（round-trip golden：由真相源組出全部子代理人設檔，逐檔與 `agents/` 目錄現況位元相同，防漂移）；`agents/*.md` 由本平台原生載入，不需額外派工機制。 |
| 6 | Stop／progress hook 不因輸出 schema 或並行順序失效 | pass | `plugins/loops-workflow/hooks/test-stop-concurrency.mjs`（13 條斷言全綠，真子行程併發寫入同一份 state 檔、rename 失敗清殘檔、清理失敗不冒泡三段皆驗）；`plugins/loops-workflow/hooks/test-stop-gate.mjs`。 |
| 7 | 同一 fixture 產生等價的 canonical state transition | pass | `plugins/loops-workflow/scripts/test-canonical-contracts.mjs`（B 段，loop 狀態檔的 canonical schema 對版控內 fixture 與既有真實樣本皆驗過，23 條斷言全綠）；`plugins/loops-workflow/hooks/test-harness-equivalence.mjs` 案例 1/2（真 spawn 本平台 guard，驗證同一正規化輸入產生一致 deny/allow 判定）。 |

## Codex 平台

Codex CLI 未安裝在本機；即使補裝，依既有已驗證的結論，安裝後要跑到「開新工作」之後的步驟仍需要一個已登入認證的隔離 `CODEX_HOME` 環境才能繼續。因此下列全部七步涉及真互動 session 的部分一律 `not_measured`，重播指令需要在具備該認證環境時才能執行。

| # | 步驟 | status | 重播指令 |
|---|---|---|---|
| 1 | dispatch 分類並建立/resume loop | not_measured | `CODEX_HOME=<已認證隔離 home> "<codex 絕對路徑>" exec -C <repo> "dispatch 一條 build 類任務"`；查是否建立 git worktree 且 `.loops` 正確錨定主 repo。另對既有 `.loops/<slug>/` 下 resume/dispatch，查是否正確從記錄階段續跑。 |
| 2 | 真正決策點出現結構化選項 | not_measured | `CODEX_HOME=<已認證隔離 home> "<codex 絕對路徑>" exec --json -C <repo> "<會觸發決策點的 prompt>"`；解析 `--json` 輸出流，觀察是否出現對應問題/使用者輸入的事件、其形狀是否可穩定 surface。 |
| 3 | guard 能阻擋錯誤落點 | not_measured | `CODEX_HOME=<已認證隔離 home> "<codex 絕對路徑>" exec --json -C <repo> "在非受管目錄外對已建 loop 分支跑 git checkout -b <slug>"`；比對本平台側投影後的 hook 事件，觀察是否出現對應的拒絕決策。 |
| 4 | file edit guard 能看見平台實際 edit payload | not_measured | `CODEX_HOME=<已認證隔離 home> "<codex 絕對路徑>" exec --json -C <repo> "跑 echo hello，然後編輯一個測試檔加一行"`；讀事件的 `tool_name` 與 payload 欄位，比對是否符合現行正規化層假設的形狀。 |
| 5 | subagent persona 可被平台載入或由 adapter 正確派出 | not_measured | `CODEX_HOME=<已認證隔離 home> "<codex 絕對路徑>" exec --json -C <repo> "<會派子代理的 prompt>"`；觀察是否出現子代理派工事件、其角色與模型設定是否對得上能力清單的映射表。 |
| 6 | Stop／progress hook 不因輸出 schema 或並行順序失效 | not_measured | `CODEX_HOME=<已認證隔離 home>` 對同一 session 觸發兩個並發 hook 事件（例如同時編輯兩個檔案），觀察是否有序列化／競態保護機制、輸出是否仍完整不半截。 |
| 7 | 同一 fixture 產生等價的 canonical state transition | not_measured | `CODEX_HOME=<已認證隔離 home> "<codex 絕對路徑>" exec --json -C <repo> "<與 Claude 側同一份 fixture prompt>"`；比對兩平台各自產生的 loop 狀態檔內容，是否在拿掉平台專屬欄位後語意等價（同樣的階段序列、同樣的最終狀態）。 |

## 資料區塊（供機械檢查解析，勿手改結構，只能改內容）

```json
{
  "cells": [
    { "step": 1, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/evals/baseline/corpus/route-slug-resume.json; plugins/loops-workflow/scripts/test-canonical-contracts.mjs", "repro": "" },
    { "step": 2, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/evals/baseline/corpus/high-risk-182-safe-stop.json", "repro": "" },
    { "step": 3, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/hooks/test-worktree-guard.mjs; plugins/loops-workflow/hooks/test-path-guard.mjs", "repro": "" },
    { "step": 4, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/hooks/test-config-protection.mjs; plugins/loops-workflow/evals/baseline/corpus/quality-bug-130-guard-matcher.json", "repro": "" },
    { "step": 5, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/scripts/test-gen-reviewers.mjs", "repro": "" },
    { "step": 6, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/hooks/test-stop-concurrency.mjs; plugins/loops-workflow/hooks/test-stop-gate.mjs", "repro": "" },
    { "step": 7, "platform": "claude", "status": "pass", "evidence": "plugins/loops-workflow/scripts/test-canonical-contracts.mjs; plugins/loops-workflow/hooks/test-harness-equivalence.mjs", "repro": "" },
    { "step": 1, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> \"<codex 絕對路徑>\" exec -C <repo> \"dispatch 一條 build 類任務\" ；查是否建立 git worktree 且 .loops 正確錨定主 repo；另對既有 .loops/<slug>/ 下 resume/dispatch，查是否正確從記錄階段續跑" },
    { "step": 2, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> \"<codex 絕對路徑>\" exec --json -C <repo> \"<會觸發決策點的 prompt>\" ；解析 --json 輸出流，觀察是否出現對應問題/使用者輸入的事件" },
    { "step": 3, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> \"<codex 絕對路徑>\" exec --json -C <repo> \"在非受管目錄外對已建 loop 分支跑 git checkout -b <slug>\" ；比對投影後的 hook 事件，觀察是否出現拒絕決策" },
    { "step": 4, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> \"<codex 絕對路徑>\" exec --json -C <repo> \"跑 echo hello，然後編輯一個測試檔加一行\" ；讀事件的 tool_name 與 payload 欄位" },
    { "step": 5, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> \"<codex 絕對路徑>\" exec --json -C <repo> \"<會派子代理的 prompt>\" ；觀察是否出現子代理派工事件" },
    { "step": 6, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> 對同一 session 觸發兩個並發 hook 事件（例如同時編輯兩個檔案），觀察是否有序列化／競態保護機制" },
    { "step": 7, "platform": "codex", "status": "not_measured", "evidence": "", "repro": "CODEX_HOME=<已認證隔離 home> \"<codex 絕對路徑>\" exec --json -C <repo> \"<與 Claude 側同一份 fixture prompt>\" ；比對兩平台各自產生的 loop 狀態檔內容是否語意等價" }
  ]
}
```
