# eval-live-candidate — live-candidate orchestration recipe

> 把 #36 pass^k 引擎 + 候選協定接成**可跑的活流程**。**候選重生（覆寫 workspace）＝主迴圈/Workflow 的事（本 recipe）**；spawn oracle 收一行 run＝`scripts/eval-runs.mjs`（不重生、不 spawn workflow）；pass^k 彙整＝既有 `scripts/eval-passk.mjs`。完整候選生成協定 + 成本/沙箱邊界見 `evals/live/README-protocol.md`（#36）。

## 流程（主迴圈照做；cwd＝repo 根）
對語料庫每個 task（`evals/<stage>/*.json`，含 oracle failToPass/passToPass）：

1. **獨立重生 N 個候選**（N 建議 3–5）：每次讓 Claude / workflow **從乾淨起點**重跑該 task → 產候選實作。**每次必須獨立**（不同 session/隨機性），否則退化成固定候選、pass^k≡pass@1。
2. **把候選就地覆寫進 task 宣告的 `workspace`**（⚠️ 關鍵接縫，見 #36 protocol）：`eval-oracle` 只評 task JSON 的固定 `task.workspace`、且須落在 plugin 根內（過 containment），**無 `--workspace` 覆寫旗標**。候選只能改實作、不可動 test 定義。**每輪覆寫前清掉前一候選殘留**（或用乾淨候選夾再覆寫）——否則上一輪新增的檔殘留會污染本輪評分。
3. **（CI / 不完全信任候選時）先過沙箱隔離**（#52，opt-in）：在 spawn oracle 前用 `eval-sandbox.mjs` 構造隔離執行指令，把候選 `scripts.test` 包進容器跑：
   ```bash
   # 第一層詞法 containment（root 內才放行）+ 第二層容器 policy/指令（不執行，印 would-run argv）
   node plugins/loops-workflow/scripts/eval-sandbox.mjs plan \
     --workspace plugins/loops-workflow/evals/<stage>/<workspace> --root plugins/loops-workflow \
     --runner docker --memory 512m   # → {argv, policy, valid, containment}；valid 才往下
   ```
   - **CI 接線**：取 `plan` 輸出的 `argv`（`docker run --network none --read-only --memory … --cap-drop ALL --security-opt no-new-privileges -v <ws>:/work …`）由 **CI runner 實際執行**該隔離容器跑候選評分（script 只建構/驗證、不執行容器）。
   - `LOOPS_SANDBOX_RUNNER` 未設 → `none`（policy `isolated:false`、只第一層詞法）；CI 自動跑前務必設 docker/podman 並確認 `valid:true`。
   - **⚠️ 真容器逃逸/越權阻擋需 CI runtime 實測**（本機 script 只驗 policy 結構 + 詞法 containment，見 README-protocol 沙箱段）。
4. **跑 `eval-runs record` 收一行 run**（spawn oracle 評當前 workspace → append 一行）：
   ```bash
   node plugins/loops-workflow/scripts/eval-runs.mjs record \
     --dir plugins/loops-workflow/evals/<stage> --task <id> --runs-file .loops/.metrics/runs.jsonl [--run-index <0..N-1>]
   ```
   → 印並 append `{taskId, pass, errored, runIndex}`。
   - exit code：成功 0 / 缺旗標·未知命令 2 / **oracle 取不到結果 · task 不在語料 · append 失敗 3**（infra 錯不偽裝成 fail run、也不 append）。
   - **errored run**（`errored:true`）＝oracle 跑了但**沒驗到**（語料缺 required test / workspace 被 containment 拒 / gate flaky）——記為 `pass:false` 但標 `errored`、stderr 出聲。**別把它當「候選不可靠」讀**；若某 task **每輪都 errored**，多半是語料/環境設定問題（workspace 路徑、required test 名），先修設定再看 pass^k。
5. **重複 1–4 共 N 次**（每次重生覆寫 +〔CI 沙箱〕+ record；步驟 3 沙箱為 opt-in），跨 task 也累積進同一 `runs.jsonl`。
6. **算真 pass@1 + pass^k**（既有引擎）：
   ```bash
   node plugins/loops-workflow/scripts/eval-passk.mjs passk --runs .loops/.metrics/runs.jsonl --k <k>
   ```
   → per-task `{passAt1, passHatK}` + overall。pass^k 抓「平均沒退、其實變不穩」。

## 不變量 / 邊界
- `eval-runs.mjs` **不重生候選、不 spawn workflow**——重生（覆寫 workspace）是本 recipe 步驟 1–2（主迴圈）。
- **infra 錯 vs 候選 fail 分清**：record 對「oracle 取不到 / task 不在語料」exit 3（不混成 pass:false）；errored 候選＝pass:false 的合法失敗 run。
- **成本**（task × N × 多 agent 很貴）+ **沙箱**（跑候選＝任意碼、沿用 eval-oracle 信任邊界；容器化雙層隔離＝#52 已落地〔`eval-sandbox.mjs` 第一層詞法 containment + 第二層容器 policy/指令、步驟 3〕、真跑容器需 CI runtime）：完整邊界見 `evals/live/README-protocol.md`。建議小語料庫（5–15 task）+ N=3–5。
- pass^k 為估算（N 有限）、標來源（#36 誠實邊界）。
