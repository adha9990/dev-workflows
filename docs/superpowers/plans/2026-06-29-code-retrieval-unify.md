# verify 統一用 codebase-memory 檢索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 explore 已驗證的「graph 查穩定周邊 + staleness 紀律」抽成共用正本 `references/code-retrieval.md`，讓 verify 的 16 個 reviewer 也能用 codebase-memory-mcp 檢索（降 token），且不審到 stale code。

**Architecture:** 新增單一正本 reference；explore 改引用它（DRY）；16 reviewer 的 `tools:` frontmatter 加 codebase-memory-mcp 唯讀子集 + 一行檢索指示；verify orchestrator 派 reviewer 時注入正本路徑 + 改動檔清單 + staleness 事實。無 runtime code、無 TDD。

**Tech Stack:** Markdown（SKILL.md / agents/*.md / references/*.md）+ agent frontmatter `tools:`。無程式。

## Global Constraints

- 對外/內文一律**繁體中文**；identifier / 路徑 / 指令 / 工具名保留英文。
- reviewer 加的 mcp 工具**唯讀子集（8 個）**，逐字：`mcp__codebase-memory-mcp__search_graph`、`mcp__codebase-memory-mcp__search_code`、`mcp__codebase-memory-mcp__trace_path`、`mcp__codebase-memory-mcp__get_code_snippet`、`mcp__codebase-memory-mcp__get_architecture`、`mcp__codebase-memory-mcp__detect_changes`、`mcp__codebase-memory-mcp__index_status`、`mcp__codebase-memory-mcp__list_projects`。**不得加** `index_repository`/`delete_project`/`manage_adr`/`ingest_traces`（寫入/重動作）。
- **staleness 鐵則**：worktree / 未提交 / `detect_changes` 的 changed_files（＝正在審的 diff）一律讀實檔、不信 graph。每個新增指示都要帶這條。
- **reviewer 既有工具保留**：每個 reviewer 原本的 `Read, Grep, Glob`（security-reviewer 另含 `WebFetch, WebSearch`）不可刪。
- **explore 不可退化**：改引用後仍須保有 staleness 紀律與 Explore-agent fallback。
- repo：`C:\Users\Eagle\Documents\GitHub\dev-workflows`，branch `verify-codebase-memory`（**不要切 branch**）。用絕對路徑。
- 每個 edit 前**先 Read 該檔**，融進既有結構。commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1：新增 `references/code-retrieval.md`（統一檢索正本）

**Files:**
- Create: `plugins/loops-workflow/references/code-retrieval.md`

**Interfaces:**
- Produces：檢索方法正本（何時用 graph、staleness 三類、分支策略、fallback、verify 範例）。Task 2/3/4 都引用它。

- [ ] **Step 1：逐字建立 `references/code-retrieval.md`**

````markdown
# 統一 code 檢索（codebase-memory-mcp + staleness 紀律）

> loops 各階段 / 各 subagent 探索 code 的**單一正本方法**。原則：**graph 查穩定的既有 code（token 便宜）、改動的 code 一律讀實檔（防 stale）**。explore 與 verify reviewer 共用此正本——調整檢索策略只改這一處。

## 何時用 graph（repo 已索引且 ready）

先 `index_status` / `list_projects` 確認目標 repo 已索引且 ready。是 → 用 codebase-memory-mcp 查**穩定的既有 code**（比 raw grep 省 token，約 ~500t vs ~80K）：

| 需求 | 工具 |
|---|---|
| 找 function / class / route / 符號 | `search_graph`（name / label / qn pattern） |
| 呼叫鏈 / 資料流 / 跨服務 | `trace_path`（mode=calls \| data_flow \| cross_service） |
| 取某符號的確切 source | `get_code_snippet`（precise range） |
| graph-augmented 文字搜尋 | `search_code` |
| package / 分層 / cluster 全貌 | `get_architecture` |

## Staleness 鐵則（最重要 —— graph 是快照）

graph 是**索引當下的快照**。下列三類 code **很可能還沒進 graph，一律直接 Read / Grep 驗證、不可只信 graph**：

1. **worktree / 另一條 branch** 的 code
2. **未提交 / 剛改** 的 code
3. **`detect_changes` 列出的 changed_files**（＝你正在審 / 正在改的 diff）

流程：`index_status` → `detect_changes`（看自索引以來改了什麼）→ 上述三類讀實檔、其餘穩定碼才用 graph。

## 分支 / worktree 策略

loop 的 worktree 通常短命、diff 小：**複用既有 base 索引查穩定周邊 + `detect_changes` + diff 讀實檔**即可，**不需對每條 worktree / branch 重新 `index_repository`**（索引有成本，短命分支不划算）。

## Fallback

repo 未索引 / mcp 不可用 → 退回 raw `Read` / `Grep` / `Glob`（explore 另可派內建 `Explore` agent）。

## 誠實（省在哪）

省的是「**周邊 / 既有 code 的呼叫鏈與結構探索**」；**正在審 / 正在改的 diff 本身一定讀實檔**（correctness > token）。所以「追很廣」的探索（找所有 caller、查依賴方向、看架構、追 taint / 資料流）省最多。

## verify 情境範例

reviewer 收到：diff 的改動檔清單 + graph project id（若已索引）。做法：
- 改動檔（diff）→ 直接 `Read`（這是審查對象、且最可能 stale）。
- 「誰呼叫這個被改的函式 / 它依賴誰 / 落在哪層」→ `trace_path` / `search_graph` / `get_architecture` 查 graph（穩定周邊）。
- 動到的符號要看完整既有實作 → `get_code_snippet`。
````

- [ ] **Step 2：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -c "search_graph\|detect_changes\|讀實檔\|worktree\|不重\|複用既有 base\|trace_path" references/code-retrieval.md`
Expected: 非 0（含工具、staleness 三類、分支策略）。

- [ ] **Step 3：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/references/code-retrieval.md
git commit -m "docs(loops-workflow): add code-retrieval reference (graph + staleness)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2：explore 改引用正本（DRY）

**Files:**
- Modify: `plugins/loops-workflow/skills/explore/SKILL.md`

**Interfaces:**
- Consumes：`references/code-retrieval.md`（Task 1）。

- [ ] **Step 1：Read `skills/explore/SKILL.md`**，定位 §0/§1 那段「codebase-memory-mcp 工具列（search_graph/trace_path/...）+ staleness 三類（worktree/未提交/detect_changes）」的 inline 區塊（約 line 43-49）。

- [ ] **Step 2：把該 inline 區塊精簡成指向正本**

把「列工具 + staleness 三類」那段，替換成（保留 explore 既有上下文，只把可共用的檢索/staleness 細節改成指引）：

```markdown
**內部檢索一律依 `references/code-retrieval.md`**（單一正本）：repo 已索引 ready → 用 codebase-memory-mcp 查穩定周邊（`search_graph`/`trace_path`/`get_code_snippet`/`search_code`/`get_architecture`）；**worktree / 未提交 / `detect_changes` 的 changed_files 一律讀實檔、不信 stale graph**；未索引 / mcp 不可用 → 派內建 `Explore` agent（read-only）或 raw Grep。
```

**保留 explore 專屬內容**：發散/收斂兩出口、評估維度、Explore-agent fallback 的角色說明、Verification checklist。**不要把 explore 整段砍掉**——只把「檢索工具列 + staleness 三類」的重複細節換成指向正本的一段。

- [ ] **Step 3：explore Verification checklist 的 staleness 那條也指向正本**

把 checklist 裡「剛改 / worktree / 未提交的 code 已用 detect_changes + 直接 Read 驗證」那條，句末加「（見 `references/code-retrieval.md`）」，讓正本是單一來源。

- [ ] **Step 4：驗證 explore 仍自洽**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -c "code-retrieval\|Explore.*agent\|fallback\|detect_changes\|讀實檔" skills/explore/SKILL.md`
Expected: 非 0（引用正本 + 仍保留 Explore-agent fallback + staleness 仍在）。

- [ ] **Step 5：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/skills/explore/SKILL.md
git commit -m "docs(loops-workflow): explore references shared code-retrieval (DRY)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3：16 個 verify reviewer 加唯讀 mcp 工具 + 檢索指示

**Files（全部 Modify，`plugins/loops-workflow/agents/` 下）：**
`product-contract-reviewer.md`、`architecture-reviewer.md`、`security-reviewer.md`、`performance-reviewer.md`、`code-quality-reviewer.md`、`tests-reviewer.md`、`accessibility-reviewer.md`、`ci-cd-reviewer.md`、`docs-devex-reviewer.md`、`frontend-ui-reviewer.md`、`migration-reviewer.md`、`observability-reviewer.md`、`processing-reliability-reviewer.md`、`root-cause-reviewer.md`、`web-performance-reviewer.md`、`finding-validator.md`（共 16）

**Interfaces:**
- Consumes：`references/code-retrieval.md`（由 verify orchestrator 在 prompt 注入絕對路徑，Task 4）。

- [ ] **Step 1：對每個檔，Read frontmatter 的 `tools:` 行**，在既有工具**後面**追加這 8 個（保留原有 `Read, Grep, Glob`，security-reviewer 保留 `WebFetch, WebSearch`）：

```
mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__search_code, mcp__codebase-memory-mcp__trace_path, mcp__codebase-memory-mcp__get_code_snippet, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__detect_changes, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__list_projects
```

例（product-contract-reviewer.md）：
`tools: Read, Grep, Glob` → `tools: Read, Grep, Glob, mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__search_code, mcp__codebase-memory-mcp__trace_path, mcp__codebase-memory-mcp__get_code_snippet, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__detect_changes, mcp__codebase-memory-mcp__index_status, mcp__codebase-memory-mcp__list_projects`

- [ ] **Step 2：對每個檔，在 body 的探索/方法相關段落加入這一行（逐字、繁中）**：

```markdown
**探索 code 的方法**：周邊既有 code 用 codebase-memory-mcp（依本 prompt 提供的 `references/code-retrieval.md`：graph 查穩定碼、省 token）；**正在審的改動檔（diff）一律讀實檔、不信 stale graph**（worktree / 未提交 / changed_files 三類）。
```

放在每個 reviewer 既有「怎麼審 / 範圍」段落的開頭或結尾，融進語氣即可。

- [ ] **Step 3：驗證 16 檔都加了 8 工具、且無寫入工具**

Run:
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow/agents
FILES="product-contract-reviewer architecture-reviewer security-reviewer performance-reviewer code-quality-reviewer tests-reviewer accessibility-reviewer ci-cd-reviewer docs-devex-reviewer frontend-ui-reviewer migration-reviewer observability-reviewer processing-reliability-reviewer root-cause-reviewer web-performance-reviewer finding-validator"
for f in $FILES; do
  ok=$(grep -c "mcp__codebase-memory-mcp__search_graph" "$f.md")
  bad=$(grep -c "index_repository\|delete_project\|manage_adr\|ingest_traces" "$f.md")
  line=$(grep -c "code-retrieval" "$f.md")
  printf '%-34s tools=%s write=%s ref=%s\n' "$f" "$ok" "$bad" "$line"
done
```
Expected: 每檔 `tools=1 write=0 ref=1`（都有唯讀工具、無寫入工具、有引用正本）。

- [ ] **Step 4：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/agents/
git commit -m "feat(loops-workflow): give verify reviewers read-only codebase-memory tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4：verify orchestrator 注入正本 + staleness guard

**Files:**
- Modify: `plugins/loops-workflow/skills/verify/SKILL.md`

**Interfaces:**
- Consumes：`references/code-retrieval.md`（Task 1）；reviewer 已具 mcp 工具（Task 3）。

- [ ] **Step 1：Read `skills/verify/SKILL.md`**，定位「派 reviewer（fan-out）」與「orchestrator 在 prompt 提供 per-axis reference 絕對路徑」的步驟（步驟 ②）。

- [ ] **Step 2：在派 reviewer 的步驟，加入注入指示（融進既有「寫進 prompt」清單）**：

```markdown
**檢索接線**：派每個 reviewer 時，prompt 額外提供：①`references/code-retrieval.md` 的絕對路徑（orchestrator 從自己的 base directory 推出 plugin root 組絕對路徑，同既有 per-axis reference 做法）；②**本次改動檔清單**（reviewer 對這些一律讀實檔）；③ 若 repo 已索引，graph project id + 提醒「`detect_changes` 顯示這些 stale」。reviewer 依此用 graph 查穩定周邊、diff 讀實檔。
```

- [ ] **Step 3：加一句 staleness guard**（融進 verify 的反偏見 / 方法段）：

```markdown
**防 stale**：reviewer 審的是 build 剛寫、常在 worktree / 未提交的 code —— graph 對這塊最不可信。依 `references/code-retrieval.md`：graph 只查穩定周邊，改動檔一律讀實檔。
```

- [ ] **Step 4：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -c "code-retrieval\|改動檔\|防 stale\|讀實檔" skills/verify/SKILL.md`
Expected: 非 0。

- [ ] **Step 5：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/skills/verify/SKILL.md
git commit -m "docs(loops-workflow): verify injects code-retrieval + staleness guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5：文件同步（AGENTS / REFERENCES / FLOW）+ 一致性走查

**Files:**
- Modify: `AGENTS.md`、`plugins/loops-workflow/docs/REFERENCES.md`、`plugins/loops-workflow/docs/FLOW.md`

- [ ] **Step 1：`AGENTS.md`** —— 在 §2 references 解析那段（subagent 讀 reference 用絕對路徑）附近，加一句：

```markdown
- **subagent 探索 code 一律依 `references/code-retrieval.md`**（graph 查穩定周邊、diff/worktree/未提交讀實檔）—— 呼應 SessionStart 的 Code Discovery Protocol（主迴圈），補上 subagent（verify reviewer 等）的檢索統一。
```

- [ ] **Step 2：`docs/REFERENCES.md`** —— 新增 `code-retrieval` 索引列（放探索/檢索或工具相關分類）：

```markdown
| `code-retrieval` | 統一 code 檢索：codebase-memory-mcp graph 查穩定周邊 + staleness 鐵則（diff/worktree/未提交讀實檔）+ 分支複用 base 索引 | explore · verify（所有 reviewer） |
```

- [ ] **Step 3：`docs/FLOW.md`** —— verify 段（§6 或 reviewer 說明）加一句註記：reviewer 用 codebase-memory 查穩定周邊、diff 讀實檔（見 `code-retrieval.md`）。以 Read 到的實際結構等義落地。

- [ ] **Step 4：全域一致性走查（本案「驗收」核心）**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
echo "=== 引用 code-retrieval 的檔（應含 explore/verify/16 reviewer/AGENTS/REFERENCES）==="
grep -rl "code-retrieval" plugins/loops-workflow AGENTS.md | wc -l
echo "=== 16 reviewer 都有唯讀工具、且無寫入工具 ==="
cd plugins/loops-workflow/agents
n=0; bad=0
for f in *-reviewer.md finding-validator.md; do
  grep -q "mcp__codebase-memory-mcp__search_graph" "$f" && n=$((n+1))
  grep -q "index_repository\|delete_project\|manage_adr\|ingest_traces" "$f" && bad=$((bad+1))
done
echo "有唯讀工具的 reviewer 數=$n（應 16）；含寫入工具的=$bad（應 0）"
```
Expected: 引用檔 ≥ 19；reviewer 數 16、寫入 0。

走查（人工）：抽 architecture-reviewer 一條情境——它收到改動檔清單 + graph project，會「改動檔讀實檔、查 caller/分層用 graph」，且 code-retrieval.md 的 staleness 三類涵蓋到 worktree 的 diff。確認 explore 改引用後仍有 Explore-agent fallback。

- [ ] **Step 5：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add AGENTS.md plugins/loops-workflow/docs/REFERENCES.md plugins/loops-workflow/docs/FLOW.md
git commit -m "docs(loops-workflow): sync AGENTS/REFERENCES/FLOW for code-retrieval

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：**
- §A 新 reference → Task 1。
- §B explore 改引用 → Task 2。
- §C verify 接線（16 reviewer 加工具 + orchestrator 注入 + guard）→ Task 3（工具）+ Task 4（注入/guard）。
- §D reviewer 各加一行 → Task 3 Step 2。
- §E 文件同步 → Task 5。
- §F YAGNI → Global Constraints（不加寫入工具）+ 範圍限 verify（未動 plan/explain/build）。

**Placeholder scan：** 無 TBD/TODO；新 reference 全文給齊；reviewer 工具清單與指示行逐字給；驗證步具體 grep。

**一致性：** 8 個唯讀工具名在 Global Constraints / Task 3 / Task 5 驗證一致；`code-retrieval.md` 路徑在 Task 2/3/4/5 一致；staleness 三類（worktree/未提交/changed_files）在 reference / reviewer 指示 / verify guard 一致；「diff 讀實檔」貫穿。

**執行性質：** 無自動測試——驗收＝Task 3/5 的 grep（16 reviewer 有唯讀工具、無寫入工具、引用正本）+ Task 5 走查（鏈接得起、explore 不退化）。最終 whole-branch review 著重：staleness 紀律是否真的能擋住「審 stale worktree code」、explore 改引用後不退化、frontmatter YAML 合法、繁中。
