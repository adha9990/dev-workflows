# eval-live-candidate — live-candidate orchestration recipe

> 把 #36 pass^k 引擎 + 候選協定接成**可跑的活流程**。**候選重生（覆寫 workspace）＝主迴圈/Workflow 的事（本 recipe）**；spawn oracle 收一行 run＝`scripts/eval-runs.mjs`（不重生、不 spawn workflow）；pass^k 彙整＝既有 `scripts/eval-passk.mjs`。完整候選生成協定 + 成本/沙箱邊界見 `evals/live/README-protocol.md`（#36）。

## 流程（主迴圈照做；cwd＝repo 根）
對語料庫每個 task（`evals/<stage>/*.json`，含 oracle failToPass/passToPass）：

1. **獨立重生 N 個候選**（N 建議 3–5）：每次讓 Claude / workflow **從乾淨起點**重跑該 task → 產候選實作。**每次必須獨立**（不同 session/隨機性），否則退化成固定候選、pass^k≡pass@1。
2. **把候選就地覆寫進 task 宣告的 `workspace`**（⚠️ 關鍵接縫，見 #36 protocol）：`eval-oracle` 只評 task JSON 的固定 `task.workspace`、且須落在 plugin 根內（過 containment），**無 `--workspace` 覆寫旗標**。候選只能改實作、不可動 test 定義。
3. **跑 `eval-runs record` 收一行 run**（spawn oracle 評當前 workspace → append 一行）：
   ```bash
   node plugins/loops-workflow/scripts/eval-runs.mjs record \
     --dir plugins/loops-workflow/evals/<stage> --task <id> --runs-file .loops/.metrics/runs.jsonl --run-index <0..N-1>
   ```
   → 印並 append `{taskId, pass, runIndex}`。oracle 取不到 / task 不在報告 → exit 3（不偽裝成 fail run）。
4. **重複 1–3 共 N 次**（每次重生覆寫 + record），跨 task 也累積進同一 `runs.jsonl`。
5. **算真 pass@1 + pass^k**（既有引擎）：
   ```bash
   node plugins/loops-workflow/scripts/eval-passk.mjs passk --runs .loops/.metrics/runs.jsonl --k <k>
   ```
   → per-task `{passAt1, passHatK}` + overall。pass^k 抓「平均沒退、其實變不穩」。

## 不變量 / 邊界
- `eval-runs.mjs` **不重生候選、不 spawn workflow**——重生（覆寫 workspace）是本 recipe 步驟 1–2（主迴圈）。
- **infra 錯 vs 候選 fail 分清**：record 對「oracle 取不到 / task 不在語料」exit 3（不混成 pass:false）；errored 候選＝pass:false 的合法失敗 run。
- **成本**（task × N × 多 agent 很貴）+ **沙箱**（跑候選＝任意碼、沿用 eval-oracle 信任邊界、容器化＝#52）：完整邊界見 `evals/live/README-protocol.md`。建議小語料庫（5–15 task）+ N=3–5。
- pass^k 為估算（N 有限）、標來源（#36 誠實邊界）。
