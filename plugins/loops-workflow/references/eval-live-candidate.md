# eval-live-candidate — live-candidate orchestration recipe

> 把 #36 pass^k 引擎 + 候選協定接成**可跑的活流程**。**候選重生（覆寫 workspace）＝主迴圈/Workflow 的事（本 recipe）**；spawn oracle 收一行 run＝`scripts/eval-runs.mjs`（不重生、不 spawn workflow）；pass^k 彙整＝既有 `scripts/eval-passk.mjs`。完整候選生成協定 + 成本/沙箱邊界見 `evals/live/README-protocol.md`（#36）。

## 流程（主迴圈照做；cwd＝repo 根）
對語料庫每個 task（`evals/<stage>/*.json`，含 oracle failToPass/passToPass）：

1. **獨立重生 N 個候選**（N 建議 3–5）：每次讓 Claude / workflow **從乾淨起點**重跑該 task → 產候選實作。**每次必須獨立**（不同 session/隨機性），否則退化成固定候選、pass^k≡pass@1。
2. **把候選就地覆寫進 task 宣告的 `workspace`**（⚠️ 關鍵接縫，見 #36 protocol）：`eval-oracle` 只評 task JSON 的固定 `task.workspace`、且須落在 plugin 根內（過 containment），**無 `--workspace` 覆寫旗標**。候選只能改實作、不可動 test 定義。**每輪覆寫前清掉前一候選殘留**（或用乾淨候選夾再覆寫）——否則上一輪新增的檔殘留會污染本輪評分。
3. **（CI / 不完全信任候選時）沙箱隔離 + 在容器內評分**（#52，opt-in）：用 `eval-sandbox.mjs plan` 構造隔離執行指令，**且讓容器跑的是「評分命令」而非預設 `npm test`**（用 `--test-cmd`），這樣**真正算分的那次執行**才在沙箱內：
   ```bash
   # 第一層詞法 containment（root 內才放行）+ 第二層容器 policy/指令（不執行，印 would-run argv）
   node plugins/loops-workflow/scripts/eval-sandbox.mjs plan \
     --workspace plugins/loops-workflow/evals/<stage>/<workspace> --root plugins/loops-workflow \
     --runner docker --memory 512m \
     --test-cmd "node /work/oracle-in-container.mjs"   # 容器內跑評分；省略則預設 npm test
   # → {argv, policy, valid, containment}；valid:true（且非逃逸）才往下；exit 1＝valid:false（fail-closed）
   ```
   - **⚠️ 沙箱涵蓋範圍（重要）**：`plan` 只**建構/驗證、不執行容器**。步驟 4 的 `eval-runs record → eval-oracle → quality-gate` **預設在主機上跑候選 `scripts.test`、不在容器內**——若候選不完全信任，**務必**讓步驟 4 的評分命令本身跑進步驟 3 的沙箱容器（把 `--test-cmd` 指向容器內可跑 oracle/quality-gate 的入口、或讓 CI 把整條評分鏈包進容器），否則 layer-2 容器只隔離了「另跑一次的 npm test」、真正算分那次仍裸跑主機。
   - **CI 接線（可消費契約）**：`plan` 的 `argv` 是 CI 可直接執行的指令。最小 GitHub Actions step：
     ```yaml
     - run: |
         PLAN=$(node plugins/loops-workflow/scripts/eval-sandbox.mjs plan \
           --workspace "$WS" --root plugins/loops-workflow --runner docker --memory 512m --test-cmd "$SCORE_CMD")
         echo "$PLAN" | node -e 'const p=JSON.parse(require("fs").readFileSync(0));if(!p.valid)process.exit(1);require("child_process").spawnSync(p.argv[0],p.argv.slice(1),{stdio:"inherit"})'
     ```
   - `LOOPS_SANDBOX_RUNNER` 未設 → `none`（policy `isolated:false`、`plan` exit 1 fail-closed；要無容器跑須顯式 `--allow-unsandboxed`）；CI 自動跑前務必設 docker/podman 並確認 `valid:true`。
   - **⚠️ 真容器逃逸/越權阻擋需 CI runtime 實測**（本機 script 只驗 policy 結構 + 詞法 containment、**未在 CI 實跑過**，見 README-protocol 沙箱段）。實際 CI job 執行屬 operator 接線（上方 step 為可貼範例、非已驗管線）。
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
