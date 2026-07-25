# reviewer-shared —— reviewer/validator agent 共用樣板單一真相源

> 這裡是 21 個 reviewer/validator agent 檔共用樣板的**唯一真相源**。改任一塊 → 跑 `node scripts/gen-reviewers.mjs --write` 重生 21 檔。
> 每塊以 `<!-- BEGIN:key -->`/`<!-- END:key -->` 逐字框定（raw 取用，塊內含 `##`/backtick 皆安全）。**手改 agents/*.md 而非改這裡＝漂移，CI `--check` 會擋。**

<!-- BEGIN:TOOLS_STANDARD -->
Read, Grep, Glob, mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__search_code, mcp__codebase-memory-mcp__trace_path, mcp__codebase-memory-mcp__get_code_snippet, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__detect_changes, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__list_projects
<!-- END:TOOLS_STANDARD -->

<!-- BEGIN:TOOLS_WEB -->
Read, Grep, Glob, WebFetch, WebSearch, mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__search_code, mcp__codebase-memory-mcp__trace_path, mcp__codebase-memory-mcp__get_code_snippet, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__detect_changes, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__list_projects
<!-- END:TOOLS_WEB -->

<!-- BEGIN:CODE_RETRIEVAL -->
**探索 code 的方法**：周邊既有 code 用 codebase-memory-mcp（依本 prompt 提供的 `references/code-retrieval.md`：graph 查穩定碼、省 token）；**正在審的改動檔（diff）一律讀實檔、不信 stale graph**（worktree / 未提交 / changed_files 三類）。
<!-- END:CODE_RETRIEVAL -->

<!-- BEGIN:OUTPUT_HEAD_SCALE -->
## 輸出

每個缺口一筆，格式見 orchestrator 在 prompt 提供的 `reviewer-severity.md` 絕對路徑（你的 CWD 是使用者 repo，相對路徑讀不到；找不到就用以下欄位）：**P0–P3 + Confidence（50/75/100）+ Route**。**雙視角**：
<!-- END:OUTPUT_HEAD_SCALE -->

<!-- BEGIN:OUTPUT_HEAD_PLAIN -->
## 輸出

每個缺口一筆，格式見 orchestrator 在 prompt 提供的 `reviewer-severity.md` 絕對路徑（你的 CWD 是使用者 repo，相對路徑讀不到；找不到就用以下欄位）：**P0–P3 + Confidence + Route**。**雙視角**：
<!-- END:OUTPUT_HEAD_PLAIN -->

<!-- BEGIN:OUTPUT_HEAD_NOCWD -->
## 輸出

每個缺口一筆，格式見 orchestrator 在 prompt 提供的 `reviewer-severity.md` 絕對路徑：**P0–P3 + Confidence + Route**。**雙視角**：
<!-- END:OUTPUT_HEAD_NOCWD -->

<!-- BEGIN:METRIC_BARE -->
套 **Metric-Honesty**。只回本軸發現。
<!-- END:METRIC_BARE -->

<!-- BEGIN:DEEP_NOTE -->
> **此檔是 `{{DEEP_BASE}}.md` 的高風險 opus·high 變體（{{DEEP_NOTEKIND}}逐字複製 base）；base 若改{{DEEP_BEHAVIOR}}，本檔須一併同步。** 差別只在 model/effort（{{DEEP_DEPTH}}）。
<!-- END:DEEP_NOTE -->

