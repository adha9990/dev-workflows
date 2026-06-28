# live-candidate 評測協定（真 pass^k）

> E1 對**固定候選**跑確定性 oracle → pass^k ≡ pass@1（退化）。要量「workflow 是否真跑出對的東西」+「隨機性下穩不穩」，需**每次重生候選**。`eval-passk.mjs` 只做確定性 pass^k 計算；**候選重生（真跑 workflow）是上層（主迴圈/Workflow）的事，script 不 spawn**。

## 協定（上層 opt-in 怎麼接）
對語料庫每個 task（`evals/<stage>/*.json`，含 oracle failToPass/passToPass）：
1. **重生 N 個候選**（N 建議 3–5）：每次讓 Claude / workflow **從乾淨起點**重跑該 task → 產一份候選實作。**每次必須是獨立重生**（不同 session/隨機性），否則退化成固定候選、pass^k≡pass@1。
2. **把候選就地覆寫進 task 宣告的 `workspace`，再跑 oracle**：⚠️ **關鍵接縫** —— `eval-oracle.mjs` **無 `--workspace` 覆寫旗標**，它只評 task JSON 裡那條固定 `task.workspace`，且該路徑**須落在 plugin 專案根內**（`../` 逃逸 / 絕對路徑 → errored、不 spawn，見 `eval-harness.md` E1）。所以每輪要把重生的候選**覆寫進 `task.workspace` 指的根內目錄**（別把候選產到 repo 外暫存夾再指過去——會撞 containment），或為候選改寫一份指向根內候選夾的暫時 task JSON。**候選只能改實作、不可動 test 定義**（見下沙箱段 oracle 完整性）。然後 `node scripts/eval-oracle.mjs --dir <task-dir> --task <id> --json` → 取該 task 的 `pass`。
3. **寫一行 runs.jsonl**：`{ "taskId": "<id>", "pass": <bool>, "errored": <bool>, "runIndex": <0..N-1> }`（用 `eval-runs.mjs record` 自動產，見 `references/eval-live-candidate.md`）。
4. 全部跑完 → `node scripts/eval-passk.mjs passk --runs <runs.jsonl> --k <k>` 得 per-task 真 pass@1 + pass^k。

## runs.jsonl schema（每行一次候選跑）
```jsonc
{ "taskId": "b1-add",   // 對應語料庫 task id
  "pass": true,          // 該次候選經 oracle 判定是否通過（failToPass 全綠 + passToPass 無回歸）
  "errored": false,      // oracle 是否「沒驗到」（缺 required test / containment 拒 / gate flaky）；errored→pass 必 false，但別當候選不可靠讀
  "runIndex": 0 }        // 第幾次重生（0..N-1，選填、僅供追溯）
```

## pass^k 解讀
- `pass@1`＝平均成功率（passed/N）。
- `pass^k`＝**隨機性下連 k 次全綠的可靠度**，無偏估計 `C(passed,k)/C(N,k)`（一隨機 k-子集全綠的機率）。
- **為何要 pass^k**：pass@1 可能「平均沒退、其實變更不穩」——4/5 的 pass@1=0.8 但 pass^2=0.6。回歸 gate 看 pass^k 更能抓「變不穩」。
- `k > N` → **無法估計、回 null**（不假裝）。N 有限 → pass^k 是**估算**（Metric-Honesty）。

## 成本邊界（⚠️ 真跑很貴）
- 成本 ≈ **task 數 × N 次重生 × 每次 workflow 的多 agent 成本**。一個 5-task 語料庫、N=5、每次跑完整 loop（多 subagent）→ 可能數十萬 token 級。
- **建議**：小語料庫（5–15 task）+ N=3–5；只在「要量可靠度」時跑（日常回歸用 E1 固定候選 oracle 即可，便宜）。
- pass^k 的 N 取 3–5 已能抓出明顯不穩；N 越大越準但成本線性增。

## 沙箱/信任邊界（⚠️ 跑候選＝執行任意碼）—— 雙層隔離（#52 已落地）
跑候選 workspace 的 `scripts.test`＝**任意程式碼**。兩層防護：

- **第一層：詞法 containment（既有、可確定性測）**。`eval-oracle.mjs` 只評落在 plugin 專案根內的 `task.workspace`，`../` / 絕對逃逸 → errored 不 spawn。`eval-sandbox.mjs` 的 `checkContainment(workspace, root)` 把這條形式化（CLI `eval-sandbox.mjs check --workspace <p> --root <r>`：root 內 exit 0 / 逃逸 exit 1）。
- **第二層：容器隔離（#52 新增）**。`eval-sandbox.mjs` 的 `buildSandboxCommand`/`validateSandboxPolicy` 構造並驗證受限執行指令：`--network none`（網路隔離）、`--read-only` rootfs + `--tmpfs`（FS 受限）、`--memory`/`--pids-limit`/`--cpus`（資源上限）、`--cap-drop ALL` + `--security-opt no-new-privileges`（越權被擋）。runtime 由 `LOOPS_SANDBOX_RUNNER`（docker/podman）選、未設 → `none`（fail-closed：policy `isolated:false`、明確 violation，只剩第一層詞法）。
  - **CLI `eval-sandbox.mjs plan --workspace <p> --root <plugin-root> --runner docker [--memory … --test-cmd "<容器內評分命令>"]`** 印 would-run argv + policy JSON、**不執行容器**（建構 + 驗證，真跑留 CI runtime）。**判 `valid` 欄、非 exit code 心態**——但 CLI 已 fail-closed：`valid:false`（含未設 runner 的 none 模式）→ **exit 1**；要無容器跑須顯式 `--allow-unsandboxed`（none 模式才 exit 0）。**省略 `--root` 會退到 cwd**（邊界較寬）→ 範例一律帶 `--root plugins/loops-workflow` 對齊 oracle plugin-root 邊界。
  - **⚠️ 沙箱涵蓋的是哪次執行**：`plan` 容器跑的命令預設 `npm test`；**真正算分的 oracle/quality-gate 預設在主機跑、不在容器內**。不完全信任候選時，要把評分命令本身用 `--test-cmd` 指進容器（見 `eval-live-candidate.md` 步驟 3），否則 layer-2 只隔離了另跑一次的 test、算分那次仍裸跑主機。
  - **⚠️ Metric-Honesty**：script 交付「**建構 + 驗證隔離指令/policy**」與「**詞法 containment 阻擋**」（可確定性測）；**真跑容器 + 真逃逸/越權測試需 CI container runtime**（本機無 runtime 不可確定性測容器逃逸、未在 CI 實跑過）→ 第二層的執行與逃逸驗證屬 recipe/CI（見 `references/eval-live-candidate.md`），未在 script 內實測。
  - 仍守原則：**只在信任來源語料庫上跑**；候選雖受 task 約束仍視為需審產物。
- oracle 完整性：候選**只能改實作、不可改 test 定義**（否則可塞必過的同名 test 偽造 failToPass）——語料庫須自擁/釘死 test patch（見 `eval-harness.md` E1 oracle 完整性註）。
