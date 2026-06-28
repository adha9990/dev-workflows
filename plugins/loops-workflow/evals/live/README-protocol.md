# live-candidate 評測協定（真 pass^k）

> E1 對**固定候選**跑確定性 oracle → pass^k ≡ pass@1（退化）。要量「workflow 是否真跑出對的東西」+「隨機性下穩不穩」，需**每次重生候選**。`eval-passk.mjs` 只做確定性 pass^k 計算；**候選重生（真跑 workflow）是上層（主迴圈/Workflow）的事，script 不 spawn**。

## 協定（上層 opt-in 怎麼接）
對語料庫每個 task（`evals/<stage>/*.json`，含 oracle failToPass/passToPass）：
1. **重生 N 個候選**（N 建議 3–5）：每次讓 Claude / workflow **從乾淨起點**重跑該 task → 產一份候選實作。**每次必須是獨立重生**（不同 session/隨機性），否則退化成固定候選、pass^k≡pass@1。
2. **把候選就地覆寫進 task 宣告的 `workspace`，再跑 oracle**：⚠️ **關鍵接縫** —— `eval-oracle.mjs` **無 `--workspace` 覆寫旗標**，它只評 task JSON 裡那條固定 `task.workspace`，且該路徑**須落在 plugin 專案根內**（`../` 逃逸 / 絕對路徑 → errored、不 spawn，見 `eval-harness.md` E1）。所以每輪要把重生的候選**覆寫進 `task.workspace` 指的根內目錄**（別把候選產到 repo 外暫存夾再指過去——會撞 containment），或為候選改寫一份指向根內候選夾的暫時 task JSON。**候選只能改實作、不可動 test 定義**（見下沙箱段 oracle 完整性）。然後 `node scripts/eval-oracle.mjs --dir <task-dir> --task <id> --json` → 取該 task 的 `pass`。
3. **寫一行 runs.jsonl**：`{ "taskId": "<id>", "pass": <bool>, "runIndex": <0..N-1> }`。
4. 全部跑完 → `node scripts/eval-passk.mjs passk --runs <runs.jsonl> --k <k>` 得 per-task 真 pass@1 + pass^k。

## runs.jsonl schema（每行一次候選跑）
```jsonc
{ "taskId": "b1-add",   // 對應語料庫 task id
  "pass": true,          // 該次候選經 oracle 判定是否通過（failToPass 全綠 + passToPass 無回歸）
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

## 沙箱/信任邊界（⚠️ 跑候選＝執行任意碼）
- 每個候選 workspace 的 oracle 評分＝以當前權限跑該 workspace 的 `scripts.test`（**任意程式碼**），沿用 `eval-oracle.mjs` 的信任邊界：**只在信任來源的語料庫上跑、勿對外來/未審語料庫直接 eval**。
- 候選由 Claude 重生 → 內容受語料庫 task 約束，但仍應視為**需審的產物**；真要在 CI 自動跑，建議加容器/沙箱隔離（**本票只給邊界文件，容器化實作 out-of-scope**）。
- oracle 完整性：候選**只能改實作、不可改 test 定義**（否則可塞必過的同名 test 偽造 failToPass）——語料庫須自擁/釘死 test patch（見 `eval-harness.md` E1 oracle 完整性註）。
