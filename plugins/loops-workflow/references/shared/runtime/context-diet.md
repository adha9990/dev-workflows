# context-diet — 產生端輸出瘦身紀律（單一正本）

> loops 各階段（主線與 subagent）產生進 context 的命令輸出與檔案讀取的瘦身紀律。原則：**產生端就不產生**——事後壓縮＝有損、不採（#97 研究定案）。**零失真鐵律：任何瘦身不得損失紅燈／錯誤證據**；與 Metric-Honesty 同源（證據保真優先於省 token）。

## A. 測試／命令輸出（紅綠不對稱）

- **綠燈**：只取末行摘要（`node test-x.mjs 2>&1 | tail -1`）；多套連跑＝每套末行。
- **紅燈**：前 N 個 failure **全文不截斷**＋總計數＋**skipped 必列**（防 `.skip`／`.todo` 靜默累積）；其餘記 `+N more`。N 預設 5——經驗值（足以看出失敗模式又不灌爆 context），可依情境調、非硬規則。
- **截斷鐵律**：任何輸出被截斷（tail／head／工具上限）**必附 raw 落盤路徑**——可攜寫法：

  ```bash
  f=$(mktemp); cmd > "$f" 2>&1; tail -20 "$f"   # 摘要行尾註 [full: $f]
  ```

  （或 `"${TMPDIR:-/tmp}"`；**禁用裸 `$TMP`**——非 Windows 環境常未設，`$TMP/x.log` 會退化寫根目錄且靜默失敗。）需要完整證據時 Read 落盤檔的相關範圍，不重跑命令。
- **verbose 例外**：使用者或任務明示要完整輸出時不壓縮。
- **與 quality-gate 的分工**：`loops-quality-gate.mjs`（契約見 `quality-gate-schema.md`）是 build 內部確認點的既有實作——綠一行 `✓`、紅結構化 `file:line+message`，**契約不變、本檔不改寫它**。本節管 quality-gate **以外**的原始 Bash 輸出：scaffold 驗收、verify 跑真 app、impl-author 自跑除錯、以及一切手跑測試／建置命令。已知限制：quality-gate 的 counts 尚無 `skipped` 欄（見該 schema 註記）。

## B. gh／git 篩欄（通則）

- **gh 優先 `--json <fields>`**、需要時疊加 `--jq` 篩到所需欄位——預設文字輸出會被 tool output 上限**靜默截斷**（教訓見 `pr-feedback-sources.md`）；大結果先落盤（mktemp）再篩。
- **git 概覽先行**：`git diff --stat`／`git log --oneline` 先看形狀；需逐行內容才開 full diff，且盡量限定路徑（`git diff -- <path>`）。
- 既有正確示範＝本通則實例：iterate 的 `gh api …/comments`、dispatch 的 `git log --oneline -1`。

## C. stale-Read（session 內讀取新鮮度）

- 檔案在本 session 被**改過**（自己或任何 subagent／使用者）後，**禁止引用改動前的 Read 內容做推理**——重讀該範圍再下結論。
- 大檔用 `offset`／`limit` 範圍讀；同檔重複讀縮小到需要的段落，不整檔重讀。
- **axis 區分**（勿混淆）：`code-retrieval.md` 的 staleness 管「graph 索引快照 vs 實檔」；本節管「session 內已讀進 context 的內容 vs 檔案現況」。與 harness「自己 Edit 成功後免驗證重讀」不衝突——那是防**多餘的驗證讀**，本節禁的是**拿舊內容推理**；檔案被「別人」改過時重讀正是本節要求的。
