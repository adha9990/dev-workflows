# cost-aware model / effort 分層 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 loops 依角色靜態選 model+effort（agent frontmatter），並依風險動態覆寫 model（verify/build 派工），停止「所有 subagent 跟著 session 跑 Opus xhigh」。

**Architecture:** 新增 `references/model-effort-policy.md` 正本；20 個 agent frontmatter 各加 `model`+`effort`（Phase 1）；verify/build 派工時依風險 per-dispatch 覆寫 model（Phase 2，effort 無法 per-dispatch）。無 runtime code。

**Tech Stack:** Markdown / agent frontmatter YAML。無程式。

## Global Constraints

- 對外/內文繁中；工具/欄位名保留英文。
- **只新增** agent frontmatter 的 `model:` 與 `effort:` 兩欄，**不動**既有 `name`/`description`/`tools`（含 #73 的 codebase-memory 工具）。
- effort 合法值：`low`/`medium`/`high`/`xhigh`/`max`；model 用別名 `sonnet`/`opus`（不用完整 id）。
- **effort 無法 per-dispatch**（Claude Code 限制）→ Phase 2 動態只覆寫 `model`，不碰 effort。
- 分層值以 spec §A 為準：sonnet·medium（廣度）/ sonnet·low（窄）/ opus·high（referee）。
- repo：`C:\Users\Eagle\Documents\GitHub\dev-workflows`，branch `model-effort-policy`（不要切 branch）。用絕對路徑。
- 每個 edit 前先 Read。commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1：新增 `references/model-effort-policy.md`（政策正本）

**Files:** Create `plugins/loops-workflow/references/model-effort-policy.md`

**Interfaces:** Produces 分層表 + Phase 2 規則 + 能力邊界；Task 2–5 引用。

- [ ] **Step 1：逐字建立檔案**

````markdown
# model / effort 分層政策（cost-aware）

> loops 各 agent 依角色**靜態**選 model + effort（frontmatter）；dispatch / build / verify 依風險**動態**覆寫 model。落實 `AGENTS.md` 規則 10（便宜的先、貴的 gate）。**改分層＝改本表 + 對應 agent frontmatter 兩欄，兩者需一致。**

## 能力邊界（Claude Code）
- **model**：agent frontmatter 靜態設 + Task 派工時 per-dispatch 覆寫。優先序：env > per-dispatch > frontmatter > session。
- **effort**：agent / skill frontmatter 靜態設。優先序：env > frontmatter > session。**沒有 per-dispatch effort 參數** —— effort 無法依單次任務動態變；純 prompt「think harder」對計費無效。
- frontmatter 蓋過 session → 設了 tier，session 開 xhigh 也不會拖著 subagent 跑。

## Phase 1：靜態分層（agent frontmatter）
| tier | model | effort | agents |
|---|---|---|---|
| 廣度審查 / 一般實作 | `sonnet` | `medium` | 6 核心 reviewer（product-contract / architecture / security / performance / code-quality / tests）+ 9 條件式 reviewer（accessibility / ci-cd / docs-devex / frontend-ui / migration / observability / processing-reliability / root-cause / web-performance）+ test-author + impl-author |
| 窄任務 | `sonnet` | `low` | finding-validator、eval-judge |
| 罕見高判斷 | `opus` | `high` | referee |

## Phase 2：動態覆寫 model（派工時，只 model）
- **verify**：步驟 1 風險梯判**高風險**時，該回合把風險相關軸（尤其 `security` / `architecture` / `code-quality`）的 reviewer 以 `model: opus` 派出（覆寫 frontmatter 的 sonnet）；瑣碎 / 一般維持 sonnet。
- **build**：impl-author 遇 **XL / 標記高複雜**任務（見 `task-template`）時該次以 `model: opus` 派出；一般 sonnet。referee 已由 frontmatter opus。
- **effort 不覆寫**（無 per-dispatch）。

## 維護
改 tier：同步改本表與對應 agent 的 `model:`/`effort:` frontmatter。正本（本檔）是分層真相源。
````

- [ ] **Step 2：驗證** `cd plugins/loops-workflow && grep -c "sonnet\|opus\|effort\|per-dispatch\|Phase 2" references/model-effort-policy.md` → 非 0。
- [ ] **Step 3：Commit**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/references/model-effort-policy.md
git commit -m "docs(loops-workflow): add model-effort-policy reference

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2：20 個 agent frontmatter 加 `model` + `effort`（Phase 1）

**Files（全部 Modify，`plugins/loops-workflow/agents/`）：** 見下三組。

- [ ] **Step 1：對每個檔 Read frontmatter，在 `tools:` 行之後、`---` 結束前，新增兩行 `model:` 與 `effort:`（值依組別）。**

**組 A（`model: sonnet` / `effort: medium`）—— 17 檔**：
`product-contract-reviewer.md`、`architecture-reviewer.md`、`security-reviewer.md`、`performance-reviewer.md`、`code-quality-reviewer.md`、`tests-reviewer.md`、`accessibility-reviewer.md`、`ci-cd-reviewer.md`、`docs-devex-reviewer.md`、`frontend-ui-reviewer.md`、`migration-reviewer.md`、`observability-reviewer.md`、`processing-reliability-reviewer.md`、`root-cause-reviewer.md`、`web-performance-reviewer.md`、`test-author.md`、`impl-author.md`
每檔加：
```
model: sonnet
effort: medium
```

**組 B（`model: sonnet` / `effort: low`）—— 2 檔**：`finding-validator.md`、`eval-judge.md`
每檔加：
```
model: sonnet
effort: low
```

**組 C（`model: opus` / `effort: high`）—— 1 檔**：`referee.md`
加：
```
model: opus
effort: high
```

範例（product-contract-reviewer.md frontmatter）：
```
---
name: product-contract-reviewer
description: ...
tools: Read, Grep, Glob, mcp__codebase-memory-mcp__search_graph, ...（既有，不動）
model: sonnet
effort: medium
---
```

- [ ] **Step 2：驗證（20 檔值正確 + 既有 tools 未動 + YAML 合法）**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow/agents
A="product-contract-reviewer architecture-reviewer security-reviewer performance-reviewer code-quality-reviewer tests-reviewer accessibility-reviewer ci-cd-reviewer docs-devex-reviewer frontend-ui-reviewer migration-reviewer observability-reviewer processing-reliability-reviewer root-cause-reviewer web-performance-reviewer test-author impl-author"
for f in $A; do m=$(grep -c "^model: sonnet$" "$f.md"); e=$(grep -c "^effort: medium$" "$f.md"); printf '%-34s A model=%s effort=%s\n' "$f" "$m" "$e"; done
for f in finding-validator eval-judge; do m=$(grep -c "^model: sonnet$" "$f.md"); e=$(grep -c "^effort: low$" "$f.md"); printf '%-34s B model=%s effort=%s\n' "$f" "$m" "$e"; done
m=$(grep -c "^model: opus$" referee.md); e=$(grep -c "^effort: high$" referee.md); echo "referee C model=$m effort=$e"
echo "--- 既有 tools 仍在（抽 3 檔）---"; grep -l "tools:" product-contract-reviewer.md referee.md finding-validator.md
```
Expected: 組 A 17 檔各 `model=1 effort=1`、組 B 2 檔、referee `model=1 effort=1`；tools 行仍在。

- [ ] **Step 3：Commit**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/agents/
git commit -m "feat(loops-workflow): tier agent model+effort (cost-aware Phase 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3：verify Phase 2 —— 高風險軸 per-dispatch 拉 opus

**Files:** Modify `plugins/loops-workflow/skills/verify/SKILL.md`

- [ ] **Step 1：Read `skills/verify/SKILL.md`**，定位步驟 1（風險梯定軸）與步驟 2（派 reviewer）。
- [ ] **Step 2：在步驟 2 派 reviewer 處加一段（融進既有派工說明）**：
```markdown
**model 動態（成本，見 `references/model-effort-policy.md`）**：reviewer 預設用各自 frontmatter tier（多為 `sonnet`）。**當步驟 1 判為高風險**，該回合把風險相關軸（尤其 `security` / `architecture` / `code-quality`）的 reviewer 於 Task 派工時以 `model: opus` 覆寫；瑣碎 / 一般維持 frontmatter 預設。effort 無法 per-dispatch，不覆寫。
```
- [ ] **Step 3：驗證** `cd plugins/loops-workflow && grep -c "model-effort-policy\|model: opus\|高風險" skills/verify/SKILL.md` → 非 0。
- [ ] **Step 4：Commit**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/skills/verify/SKILL.md
git commit -m "feat(loops-workflow): verify bumps high-risk axes to opus per-dispatch (Phase 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4：build Phase 2 —— impl-author XL 任務 per-dispatch 拉 opus

**Files:** Modify `plugins/loops-workflow/skills/build/SKILL.md`

- [ ] **Step 1：Read `skills/build/SKILL.md`**，定位派 impl-author 的步驟。
- [ ] **Step 2：在派 impl-author 處加一段**：
```markdown
**model 動態（成本，見 `references/model-effort-policy.md`）**：impl-author 預設 frontmatter `sonnet`。**遇 XL / 標記高複雜的任務**（見 `references/task-template.md` 尺寸階梯）時，該次 Task 派工以 `model: opus` 覆寫；一般任務維持 sonnet。referee 已由 frontmatter opus，不需覆寫。effort 無法 per-dispatch。
```
- [ ] **Step 3：驗證** `cd plugins/loops-workflow && grep -c "model-effort-policy\|model: opus\|XL" skills/build/SKILL.md` → 非 0。
- [ ] **Step 4：Commit**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/skills/build/SKILL.md
git commit -m "feat(loops-workflow): build bumps XL impl tasks to opus per-dispatch (Phase 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5：文件同步（AGENTS 規則 10 + FLOW + REFERENCES）+ 一致性走查

**Files:** Modify `AGENTS.md`、`plugins/loops-workflow/docs/FLOW.md`、`plugins/loops-workflow/docs/REFERENCES.md`

- [ ] **Step 1：`AGENTS.md` 規則 10**（成本意識）—— Read 該規則，在「便宜的先、貴的後且要 gate」子彈附近加一句：
```markdown
- **model / effort 分層（見 `references/model-effort-policy.md`）**：subagent 依角色靜態選 model+effort（多為 `sonnet`·medium；窄任務 low；referee `opus`·high）——不跟 session 跑 xhigh；高風險時 verify/build 派工才 per-dispatch 拉 `model: opus`（effort 無法 per-dispatch）。
```
- [ ] **Step 2：`docs/FLOW.md`** —— Read §9/§10，加一句：各 agent 有 model/effort tier（見 `references/model-effort-policy.md`），高風險 verify/build 動態拉 opus。以實際結構等義落地。
- [ ] **Step 3：`docs/REFERENCES.md`** —— 新增索引列：
```markdown
| `model-effort-policy` | cost-aware：agent 依角色靜態選 model+effort、verify/build 依風險動態覆寫 model（effort 無法 per-dispatch） | 全 agent（frontmatter）· verify · build |
```
- [ ] **Step 4：一致性走查（驗收核心）**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
echo "=== 引用 policy 的檔（應含 verify/build/AGENTS/FLOW/REFERENCES）==="
grep -rl "model-effort-policy" plugins/loops-workflow AGENTS.md | wc -l
echo "=== 20 agent 都有 model + effort ==="
cd plugins/loops-workflow/agents; n=0
for f in *-reviewer.md test-author.md impl-author.md finding-validator.md eval-judge.md referee.md; do grep -q "^model:" "$f" && grep -q "^effort:" "$f" && n=$((n+1)); done
echo "有 model+effort 的 agent 數=$n（應 20）"
```
Expected: 引用檔 ≥ 5；agent 數 20。
走查（人工）：policy 表的 tier 值與各 agent frontmatter 一致（正本＝真相）；verify/build Phase 2 覆寫規則引用 policy；effort「不能 per-dispatch」在 policy/AGENTS/verify/build 一致。
- [ ] **Step 5：Commit**
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add AGENTS.md plugins/loops-workflow/docs/FLOW.md plugins/loops-workflow/docs/REFERENCES.md
git commit -m "docs(loops-workflow): sync AGENTS/FLOW/REFERENCES for model-effort-policy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：** §A Phase 1 → Task 2（+ policy 表 Task 1）；§B Phase 2 → Task 3（verify）+ Task 4（build）；§C policy 正本 → Task 1；§D 文件 → Task 5；§E YAGNI（不做主迴圈 skill effort / agent 變體 / 完整 model id）→ Global Constraints。

**Placeholder scan：** 無 TBD；policy 全文給齊；20 agent 分組 + 精確兩行值給齊；verify/build 插入段逐字；驗證步具體 grep。

**一致性：** model/effort 值（sonnet·medium / sonnet·low / opus·high）在 spec §A / policy 表 / Task 2 分組 / Task 5 驗證一致；`model-effort-policy.md` 路徑在 Task 1/3/4/5 一致；「effort 無法 per-dispatch」在 policy / verify / build / AGENTS 一致；「只加兩欄、不動 tools」在 Global Constraints + Task 2 一致。

**執行性質：** 無自動測試 —— 驗收＝Task 2/5 的 grep（20 agent 有 model+effort、tools 未動）+ Task 5 走查（policy↔frontmatter 值一致、Phase 2 規則引用 policy）。最終 whole-branch review 著重：分層值與 policy 一致、既有 agent 行為/tools 未被破壞、effort per-dispatch 限制未被誤寫成可行、frontmatter YAML 合法、繁中。
