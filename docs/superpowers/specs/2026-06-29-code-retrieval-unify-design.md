# 設計：verify 統一用 codebase-memory 檢索（複用 explore 模式）

> 狀態：草案（待使用者過目）｜日期：2026-06-29｜branch：verify-codebase-memory｜範圍：`plugins/loops-workflow`（verify reviewers + explore + 新 reference）

## 1. 問題與目標

`explore` 已把 codebase-memory-mcp 當主路徑檢索 code，但 **verify 的 14–16 個 reviewer 的 `tools:` frontmatter 全是 `Read, Grep, Glob`、無一個 mcp 工具**——它們各自 raw grep 追呼叫鏈 / 找 caller / 查依賴，6+ 個並行＝重複勞動。依 codebase-memory skill 自述「graph 結構查詢 ~500 token vs grep ~80K」，最糟可達 ~480K token 花在 raw 結構探索。

**目標**：把 explore 已驗證的「graph 查穩定周邊 + staleness 紀律」**複製到 verify**，降低 token 負擔，且**不引入 correctness 退化**。

**已拍板（使用者）**：
- 接法 **A 自助**：抽共用 reference + 給 reviewer 唯讀 mcp 工具 + orchestrator 注入 reference。
- 範圍 **先 verify**（6 核心 + 9 條件式 + finding-validator）。
- 索引 **複用 base + detect_changes**（不重索引短命 worktree）。

## 2. 關鍵 correctness 陷阱（設計的硬約束）

verify 審的是 build 剛寫、常在 worktree、未提交的 code——而 **graph 是快照，對這塊最不可信**。naive 接 graph 會讓 reviewer 審到 stale code、給假信心。

→ **explore 已解此題**（`explore/SKILL.md:47-49`：`index_status`/`list_projects` → `detect_changes` → 三類「worktree / 未提交 / changed_files」一律讀實檔）。本案把這套紀律抽成共用正本，verify 沿用。

## 3. 設計（逐節）

### §A 新增 `references/code-retrieval.md`（統一檢索方法，單一正本）
內容：
- **何時用 graph**：repo 已索引且 ready（`index_status`/`list_projects`）→ 查**穩定的既有 code**：`search_graph`（找符號）/ `trace_path`（呼叫鏈·資料流·跨服務）/ `get_code_snippet`（確切 source range）/ `search_code`（graph-augmented grep）/ `get_architecture`（分層·cluster 全貌）。token 便宜。
- **staleness 鐵則（最重要）**：`detect_changes`；三類 code **一律讀實檔、絕不只信 graph**——(a) worktree / 另一 branch、(b) 未提交 / 剛改、(c) `detect_changes` 列出的 changed_files（＝正在審的 diff）。
- **分支/worktree 策略**：複用 base 索引查穩定周邊 + `detect_changes` + diff 讀實檔；**不對短命 worktree 重新索引**（索引成本不划算）。
- **fallback**：未索引 / mcp 不可用 → raw Read/Grep（explore 另有 Explore-agent fallback）。
- **誠實**：省的是「周邊 / 呼叫鏈探索」；diff 本身一定讀實檔。

### §B explore 改引用（DRY，規則 6）
`explore/SKILL.md` §0–§1 inline 的「檢索工具列 + staleness 三類」段 → 精簡成指向 `references/code-retrieval.md`，保留 explore 專屬內容（發散/收斂、Explore-agent fallback、評估維度）。一處正本、explore 與 verify 共用，避免漂移。

### §C verify 接線
- **16 個 reviewer** 的 `tools:` frontmatter 加 codebase-memory-mcp **唯讀子集**：
  `mcp__codebase-memory-mcp__search_graph`、`__search_code`、`__trace_path`、`__get_code_snippet`、`__get_architecture`、`__detect_changes`、`__index_status`、`__list_projects`
  （**不含** `index_repository` / `delete_project` / `manage_adr` / `ingest_traces` 等寫入/重動作——reviewer 不該索引；未索引就 fallback。）
  名單：product-contract / architecture / security / performance / code-quality / tests（6 核心）+ accessibility / ci-cd / docs-devex / frontend-ui / migration / observability / processing-reliability / root-cause / web-performance（9 條件式）+ finding-validator。
- **`verify/SKILL.md` orchestrator**：派每個 reviewer 時 prompt 注入 ①`code-retrieval.md` 絕對路徑 ②**改動檔清單（讀實檔）** ③ graph project id（若已索引）+「detect_changes 顯示這些 stale」。沿用 verify 既有「per-axis reference 絕對路徑寫進 prompt」機制。
- verify SKILL 加一句 staleness guard：reviewer 審的是 worktree 新 code → 依 `code-retrieval.md` 紀律（graph 查周邊、diff 讀實檔）。

### §D 各 reviewer .md 加一行
在每個 reviewer 的探索/方法段加一句：「探索**周邊既有 code** 用 codebase-memory-mcp（依 orchestrator 提供的 `code-retrieval.md` 絕對路徑）；**改動的檔（diff）一律讀實檔、不信 graph**。」細節在正本，不在 16 檔各寫一遍。

### §E 文件同步
- `docs/REFERENCES.md`：新增 `code-retrieval` 索引（檢索/探索分類）。
- `AGENTS.md`：補一句「subagent 探索 code 依 `references/code-retrieval.md`」（呼應 SessionStart 的 Code Discovery Protocol＝主迴圈；這裡補 subagent 缺口）。
- `docs/FLOW.md`：verify 段註記 reviewer 用 codebase-memory 檢索（可選、輕量）。

### §F 不做（YAGNI）
重索引 worktree；plan / explain / build / define 觸點（之後再擴）；referee / eval-judge（非主要 code-tracer）；`query_graph` 進階 Cypher 給 reviewer（用不太到）。

## 4. 受影響檔案清單

**新增**：`references/code-retrieval.md`

**修改**：
- `skills/explore/SKILL.md`（改引用正本）
- `skills/verify/SKILL.md`（注入 + staleness guard）
- 16 個 reviewer：`agents/{product-contract,architecture,security,performance,code-quality,tests}-reviewer.md` + `agents/{accessibility,ci-cd,docs-devex,frontend-ui,migration,observability,processing-reliability,root-cause,web-performance}-reviewer.md` + `agents/finding-validator.md`（各加 mcp 唯讀工具 + 一行檢索指示）
- `AGENTS.md`、`docs/REFERENCES.md`、`docs/FLOW.md`

## 5. 執行性質與驗收

散文 + 16 個 frontmatter `tools:` 加工具，無 runtime code、無 TDD 紅綠。驗收＝**一致性 + 不退化**：
1. 16 個 reviewer 的 `tools:` 都含那 8 個唯讀 mcp 工具、且都**沒有**寫入工具。
2. `code-retrieval.md` 含完整 staleness 三類紀律 + 「diff 讀實檔」+ 不重索引 worktree。
3. `verify/SKILL.md` 有注入 `code-retrieval.md` + 改動檔清單 + staleness guard。
4. explore 改引用後**語意不退化**（仍有 staleness 紀律、仍有 Explore-agent fallback）。
5. 繁中；reviewer 反偏見/獨立性不受影響（graph 只是更快讀同一份 code）。
6. frontmatter YAML 仍合法（工具名正確 `mcp__codebase-memory-mcp__*`）。

## 6. 交付
branch `verify-codebase-memory` → 逐檔改 → 一致性走查 → PR（使用者 review 後 squash merge）。設計 spec/計畫依前例不進 PR。

## 7. 待實作時再定的小細節（不阻擋拍板）
- reviewer .md 那一行檢索指示的精確措辭（各檔語氣略不同，落地時對齊）。
- `code-retrieval.md` 是否附一個「verify 情境」的小範例（傾向附：reviewer 拿到 diff + graph project，怎麼查周邊、怎麼讀 diff）。
- explore 抽出後，是否把 explore 的 Verification checklist 那條 staleness 也指向正本（傾向是，保持單一正本）。
