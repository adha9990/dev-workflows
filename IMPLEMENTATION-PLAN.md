# loops-workflow plugin 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **完整設計藍本見 `DESIGN.md`**（同目錄）。每個 skill task 的 prose 主體依 DESIGN.md 對應 section 撰寫；本計畫給出 frontmatter 逐字值、body 必含結構、驗證證據。

**Goal:** 建立一個自包含的 Claude Code plugin `loops-workflow` —— 7 階段閉環開發工作流（dispatch → goal → explore → plan → build → verify → iterate），以 work-plugins/cto-review 為重心、融合 agent-skills 成熟做法與 Loops Engineering 閉環哲學。

**Architecture:** 全新本地 marketplace。1 個 dispatcher skill（決策樹分流）+ 6 個階段 skill，階段間 human gate（Closed Loop），`.loops/<slug>/` markdown 當階段記憶體。build 用 test-author/impl-author 紅綠分離 + Refactor，verify 以 cto-pr-reviewer 的 6 reviewer + validator 為藍本。persona 放 `agents/`、長 checklist 放 `references/`。

**Tech Stack:** Markdown（SKILL.md + persona + reference）、JSON（plugin.json / marketplace.json）、Claude Code plugin 機制（Skill / Agent / 自動發現 agents）。無 runtime code。

## Global Constraints

- 對外敘述一律**繁體中文**；code identifier / 路徑 / 指令 / skill 名保留**英文**。
- plugin name = `loops-workflow`，呼叫前綴 `loops-workflow:`。
- 每個 SKILL.md 採 skill-anatomy 骨架：`Overview / When to Use（含 NOT for）/ Process / Common Rationalizations / Red Flags / Verification`。
- description **第三人稱 what + 「Use when」觸發條件，絕不摘要 workflow 步驟**（否則 AI 照摘要做、短路 human gate）。
- 直接改寫 agent-skills 內容的檔案，頂部標 `<!-- adapted from addyosmani/agent-skills (MIT) -->`。
- progressive disclosure：patterns <50 行 inline、reference >100 行拆進 `references/`。
- 推進模式 Closed Loop：階段之間一律停下等使用者拍板。
- `.loops/` 寫進 `.gitignore`。

---

## File Structure

```
loops-workflow/（marketplace root）
├── .claude-plugin/marketplace.json          ← Task 1
├── .gitignore                               ← Task 1
├── AGENTS.md                                ← Task 2
└── plugins/loops-workflow/
    ├── .claude-plugin/plugin.json           ← Task 1
    ├── skills/
    │   ├── dispatch/SKILL.md                ← Task 3
    │   ├── goal/SKILL.md                    ← Task 4
    │   ├── explore/SKILL.md                 ← Task 5
    │   ├── plan/SKILL.md                    ← Task 6
    │   ├── build/SKILL.md                   ← Task 7
    │   ├── verify/SKILL.md                  ← Task 8
    │   └── iterate/SKILL.md                 ← Task 9
    ├── agents/
    │   ├── test-author.md / impl-author.md / referee.md      ← Task 10
    │   ├── product-contract-reviewer.md … tests-reviewer.md  ← Task 11
    │   └── finding-validator.md                              ← Task 11
    └── references/
        ├── security-checklist.md / code-simplification.md    ← Task 12
        ├── reviewer-severity.md / finding-validation.md      ← Task 13
        └── goal-restate-schema.md / task-template.md /
            change-summaries.md / adr-template.md             ← Task 14
```

---

## Task 1: Plugin 骨架（marketplace + plugin manifest）

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/loops-workflow/.claude-plugin/plugin.json`
- Create: `.gitignore`

**Interfaces:**
- Produces: plugin name `loops-workflow`（決定呼叫前綴）；marketplace 可被 `/plugin marketplace add` 載入。

- [x] **Step 1: 寫 marketplace.json**

```json
{
  "name": "loops-workflow",
  "owner": { "name": "陳駿騰", "url": "https://github.com/adha9990" },
  "metadata": { "description": "Loops Engineering 閉環開發工作流（測試性 plugin）" },
  "plugins": [
    { "name": "loops-workflow", "source": "./plugins/loops-workflow",
      "description": "7 階段閉環（dispatch→goal→explore→plan→build→verify→iterate），以 work-plugins/cto-review 為重心、融合 agent-skills + Loops Engineering" }
  ]
}
```

- [x] **Step 2: 寫 plugin.json**

```json
{
  "name": "loops-workflow",
  "version": "0.1.0",
  "description": "7 階段閉環開發工作流：dispatch 決策樹分流 → goal/explore/plan/build/verify/iterate，階段間 human gate，.loops/ markdown 記憶體，build 紅綠分離，verify 以 cto-pr-reviewer 為藍本。",
  "author": { "name": "陳駿騰", "url": "https://github.com/adha9990" },
  "keywords": ["workflow", "loop", "agentic", "closed-loop"]
}
```

- [x] **Step 3: 寫 .gitignore**

```
.loops/
```

- [x] **Step 4: 結構驗證**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json')); JSON.parse(require('fs').readFileSync('plugins/loops-workflow/.claude-plugin/plugin.json')); console.log('JSON OK')"`
Expected: 印出 `JSON OK`，無 parse error。

- [x] **Step 5: 載入驗證（在 Claude Code 裡）**

執行 `/plugin marketplace add C:/Users/Eagle/.claude/plugins/marketplaces/loops-workflow` 然後 `/plugin install loops-workflow@loops-workflow`。
Expected: plugin 安裝成功、無錯誤（此時 skills 還空，僅驗證 manifest 可載入）。

- [x] **Step 6: Commit**

```bash
git add .claude-plugin/marketplace.json plugins/loops-workflow/.claude-plugin/plugin.json .gitignore
git commit -m "feat: 建立 loops-workflow plugin 骨架（marketplace + manifest）"
```

---

## Task 2: AGENTS.md（operating rules + intent→command 對照）

**Files:**
- Create: `AGENTS.md`

**Interfaces:**
- Consumes: 無。
- Produces: 全程共用操作規則（被各 skill 預設遵守）；intent→command 對照（讓使用者跳過 dispatch 直接喊階段）。

- [x] **Step 1: 寫 AGENTS.md**，必含三段：
  1. **Operating Rules**（全程不變紀律）：繁中對外、human gate 不可跳、`.loops/` 每階段交接、模糊就 surface、Metric-Honesty（沒實跑就標 `not measured`）。
  2. **Intent → command 對照表**：`有 issue 號 → /loops-workflow:dispatch 或直接 :goal`、`設計/研究 → :explore`、`PR 回饋 → :iterate`、`只想拆任務 → :plan`…
  3. **三層融合定位**一句話（DESIGN.md §1 摘要）。

- [x] **Step 2: 驗證**

Run: `node -e "const s=require('fs').readFileSync('AGENTS.md','utf8'); if(!/Operating Rules/.test(s)||!/dispatch/.test(s)) throw new Error('缺段落'); console.log('AGENTS.md OK')"`
Expected: 印出 `AGENTS.md OK`。

- [x] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "feat: 加 AGENTS.md（共用操作規則 + intent→command 對照）"
```

---

## Task 3: dispatch skill

**Files:**
- Create: `plugins/loops-workflow/skills/dispatch/SKILL.md`

**Interfaces:**
- Produces: 決策樹分流（→ goal / explore / iterate）；建立 `.loops/<slug>/loop.md`。
- 藍本：DESIGN.md §6。

- [x] **Step 1: 寫 frontmatter（逐字）**

```yaml
---
name: dispatch
description: Routes a one-line work request to the right loops-workflow stage and sets up the loop. Use when starting any loops-workflow run, or when the user says /loops-workflow:dispatch, or is unsure which stage (goal/explore/plan/build/verify/iterate) to begin from.
---
```

- [x] **Step 2: 寫 body**（依 skill-anatomy 骨架），必含：
  - **決策樹**（逐字，DESIGN.md §6）：issue 號→goal；「設計/研究/評估」+無 issue→explore；PR/reviewer/修正→iterate；模糊→停下問。
  - 顯式語法 `dispatch <type> <ref>` 跳過判斷。
  - 確定類型後：建/認領 `.loops/<slug>/loop.md`（slug 由描述/issue 標題生 kebab-case），寫類型/起點/停止條件雛形，**交棒**（禁止自己 paraphrase 串接後續階段）。
  - **Operating Rules 入口**：引用 AGENTS.md 的全程紀律。
  - Rationalizations 表（例：「我直接幫他跑完所有階段比較快」→「Closed Loop 的價值就是每階段 gate，串接會奪走使用者判斷點」）。
  - Verification：分流結果正確 + loop.md 已建 + 已停在起點 gate。

- [x] **Step 3: 驗證（frontmatter）**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/dispatch/SKILL.md','utf8'); if(!/^---[\s\S]*name: dispatch[\s\S]*description:.*Use when/m.test(s)) throw new Error('frontmatter 不合格'); console.log('dispatch frontmatter OK')"`
Expected: 印出 `dispatch frontmatter OK`。

- [x] **Step 4: 觸發測試（Claude Code 裡）**

reload plugin，輸入 `/loops-workflow:dispatch 做 issue #5`。
Expected: 判斷為「處理 issue」、建議從 goal 開始、建立 `.loops/` loop.md、停在 gate（不自動往下跑）。

- [x] **Step 5: Commit**

```bash
git add plugins/loops-workflow/skills/dispatch/SKILL.md
git commit -m "feat(dispatch): 決策樹分流 + 操作規則入口"
```

---

## Task 4: goal skill

**Files:**
- Create: `plugins/loops-workflow/skills/goal/SKILL.md`

**Interfaces:**
- Consumes: dispatch 建的 `loop.md`。
- Produces: `.loops/<slug>/00-goal.md`（restate 六欄 + 停止條件）。
- 藍本：DESIGN.md §7①。引用 reference `goal-restate-schema.md`（Task 14）。

- [x] **Step 1: frontmatter（逐字）**

```yaml
---
name: goal
description: Turns a vague request or issue into an explicit definition-of-done and stop condition through one-question-at-a-time interview. Use when starting the goal stage of a loops-workflow run, or when requirements are unclear and need to be pinned down before exploring or planning.
---
```

- [x] **Step 2: body** 必含：
  - **以 pm-feature-intake 訪談為主**：一次一問、`AskUserQuestion` 四選項 + 推薦標記、只問 blocking 決策、能從素材推得的不問。
  - **補 interview-me 零件**：每問附 HYPOTHESIS + CONFIDENCE 數字；**restate 六欄**（Outcome / User / Why now / Success / Constraint / Out of scope，逐字當 00-goal.md schema，見 `references/goal-restate-schema.md`）；95% 信心停止；explicit-yes gate（「whatever you think ≠ yes」）。
  - 產出 `00-goal.md` 並停在 `goal → explore` 確認 gate。
  - Rationalizations / Red Flags / Verification（完工定義六欄齊全 + 停止條件可驗 + 使用者明確 yes）。

- [x] **Step 3: 驗證（frontmatter）**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/goal/SKILL.md','utf8'); if(!/name: goal/.test(s)||!/Use when/.test(s)) throw new Error('bad'); console.log('goal OK')"`
Expected: `goal OK`。

- [x] **Step 4: Commit**

```bash
git add plugins/loops-workflow/skills/goal/SKILL.md
git commit -m "feat(goal): pm-feature-intake 訪談 + restate 六欄完工定義"
```

---

## Task 5: explore skill

**Files:**
- Create: `plugins/loops-workflow/skills/explore/SKILL.md`

**Interfaces:**
- Consumes: `00-goal.md`。
- Produces: `.loops/<slug>/01-explore.md`（內部 vs 外部攤開比較 + 推薦 + source-driven 引用）。
- 藍本：DESIGN.md §7②。

- [x] **Step 1: frontmatter（逐字）**

```yaml
---
name: explore
description: Surveys internal codebase for reusable approaches then external sources for industry practice, laying both side by side with a recommendation. Use when starting the explore stage of a loops-workflow run, or when you need to research how to build something before planning it.
---
```

- [x] **Step 2: body** 必含一條龍四步（DESIGN.md §7②）：
  1. 先掃內部：派內建 `Explore`（Haiku、read-only）找可重用（reuse 優先）。
  2. 再搜外部：便宜 WebSearch / firecrawl。
  3. 不夠才深入：需看實作細節才**建議升級 deep-research（經使用者同意）**。
  4. 框架查證：source-driven DETECT→FETCH→IMPLEMENT→CITE（context7、查不到標 `UNVERIFIED`）。
  - 攤開比較 + 推薦寫 `01-explore.md`，停在 `explore → plan` 決策 gate（使用者選走哪條）。
  - Rationalizations（例：「直接 deep research 最完整」→「先便宜搜索打前哨，貴的 deep research 要 gate」）。

- [x] **Step 3: 驗證 + Commit**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/explore/SKILL.md','utf8'); if(!/name: explore/.test(s)) throw new Error('bad'); console.log('explore OK')"`
```bash
git add plugins/loops-workflow/skills/explore/SKILL.md
git commit -m "feat(explore): 內外一條龍 + source-driven 查證 + 漸進升級 deep-research"
```

---

## Task 6: plan skill

**Files:**
- Create: `plugins/loops-workflow/skills/plan/SKILL.md`

**Interfaces:**
- Consumes: `00-goal.md` + `01-explore.md`。
- Produces: `.loops/<slug>/02-plan.md`（任務清單，每任務帶 verification 指令 + ADR + 機制圖）。
- 藍本：DESIGN.md §7③。引用 `references/task-template.md`、`references/adr-template.md`（Task 14）。

- [x] **Step 1: frontmatter（逐字）**

```yaml
---
name: plan
description: Locks design decisions and breaks work into independently verifiable tasks before any code. Use when starting the plan stage of a loops-workflow run, or when an explored approach needs to become a concrete, task-by-task implementation plan.
---
```

- [x] **Step 2: body** 必含：
  - **以 plan-from-issue + 設計計畫書 §0–§9 為主**：decision record 五欄、機制圖（每機制白話 + 兩張 mermaid）、`AskUserQuestion` 拍板、套件評估 ≥3 候選比較表、clean-architecture 六維度、reuse。
  - **補 planning-breakdown 螺絲**：任務模板（含 **Verification 具體指令**欄，見 task-template.md）、尺寸表 + 「該再拆」四訊號（>2hr / acceptance >3 / 跨 2+ 子系統 / 標題有 and）、依賴圖 + 每 2-3 任務 checkpoint；ADR `Consequences` 欄。
  - 停在 `plan → build` 拍板 gate。

- [x] **Step 3: 驗證 + Commit**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/plan/SKILL.md','utf8'); if(!/name: plan/.test(s)) throw new Error('bad'); console.log('plan OK')"`
```bash
git add plugins/loops-workflow/skills/plan/SKILL.md
git commit -m "feat(plan): plan-from-issue 設計計畫書 + 可驗證任務拆解"
```

---

## Task 7: build skill

**Files:**
- Create: `plugins/loops-workflow/skills/build/SKILL.md`

**Interfaces:**
- Consumes: `02-plan.md`。
- Produces: `.loops/<slug>/03-build.md`（Change Summaries 三段式 + commit 清單 + 紅綠軌跡）；working tree 改動。
- 依賴 agents：`test-author` / `impl-author` / `referee`（Task 10）。reference：`change-summaries.md`、`code-simplification.md`。
- 藍本：DESIGN.md §7④ + §8.2。

- [x] **Step 1: frontmatter（逐字）**

```yaml
---
name: build
description: Implements each planned task via red-green-refactor with separate test-author and impl-author agents to prevent tests bending to the implementation. Use when starting the build stage of a loops-workflow run, or when a confirmed plan is ready to be coded task by task.
---
```

- [x] **Step 2: body** 必含紅→綠→重構 7 步（DESIGN.md §8.2，逐字）：
  1. 派 `test-author`（只有需求/契約 + TDD 品質判準，**看不到 impl**）→ failing test。
  2. 主線跑測試確認 **Red**。
  3. 派 `impl-author`（有 test + plan，**不准改 test**）→ 轉綠。
  4. 主線跑測試確認 **Green**。
  5. **Refactor**：impl-author 綠燈後、test 保護下，套 `code-simplification`（Chesterton's Fence + 過度簡化四陷阱 + 紅旗「簡化需改 test = 改了行為，停」）。
  6. 衝突仲裁：impl-author 主張 test 錯 → 回報主線，主線依完工定義裁決（必要派 `referee`）。
  7. 分段 commit（Save Point：pass→commit / fail→revert）+ 寫 `03-build.md`（Change Summaries 三段式）。
  - 整個 build 做完才停 `build → verify` gate（內部紅綠不每單位停）。

- [x] **Step 3: 驗證 + Commit**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/build/SKILL.md','utf8'); if(!/name: build/.test(s)||!/test-author/.test(s)||!/impl-author/.test(s)) throw new Error('bad'); console.log('build OK')"`
```bash
git add plugins/loops-workflow/skills/build/SKILL.md
git commit -m "feat(build): 紅綠分離雙 agent + Refactor step"
```

---

## Task 8: verify skill

**Files:**
- Create: `plugins/loops-workflow/skills/verify/SKILL.md`

**Interfaces:**
- Consumes: `00-goal.md` + `02-plan.md` + `03-build.md`。
- Produces: `.loops/<slug>/04-verify.md`（6 reviewer 缺口 P0–P3 + validator 結果 + Ready/Not ready）。
- 依賴 agents：6 reviewer + `finding-validator`（Task 11）。reference：`reviewer-severity.md`、`finding-validation.md`、`security-checklist.md`。
- 藍本：DESIGN.md §7⑤ + §8.3。

- [x] **Step 1: frontmatter（逐字）**

```yaml
---
name: verify
description: Fans out six independent reviewers (product/architecture/security/performance/code-quality/tests) then validates findings in a second pass, modeled on cto-pr-reviewer. Use when starting the verify stage of a loops-workflow run, or when built work needs merge-readiness review before iterate.
---
```

- [x] **Step 2: body** 必含（DESIGN.md §8.3）：
  - **主線在同一回合一次發 6 個 Agent call**（並行、fresh context、不巢狀）：product-contract / architecture / security / performance / code-quality / tests-release，各一軸。
  - security reviewer **另補威脅建模 / STRIDE / OWASP+LLM Top 10**（讀 `security-checklist.md`）；code-quality 含可讀性（code-simplification 反例）；tests reviewer 加 doubt-driven 反偏見（**不給「作者說已通過」**）。
  - coordinator（主線）去重 + 過濾純 style → 派 `finding-validator` 二輪確認每個 blocking finding（讀 `finding-validation.md`）。
  - 分級 P0–P3 + Confidence 50/75/100 + Route（讀 `reviewer-severity.md`）；所有 reviewer 套 Metric-Honesty。
  - merge 成 **Ready / Not ready** 寫 `04-verify.md`，停 `verify → iterate` gate。

- [x] **Step 3: 驗證 + Commit**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/verify/SKILL.md','utf8'); if(!/name: verify/.test(s)||!/finding-validator/.test(s)) throw new Error('bad'); console.log('verify OK')"`
```bash
git add plugins/loops-workflow/skills/verify/SKILL.md
git commit -m "feat(verify): cto-pr-reviewer 六 reviewer + validator 二輪 + security 補強"
```

---

## Task 9: iterate skill

**Files:**
- Create: `plugins/loops-workflow/skills/iterate/SKILL.md`

**Interfaces:**
- Consumes: `04-verify.md` / PR 回饋。
- Produces: `.loops/<slug>/05-iterate.md`（triage + 回環決策）；更新 `loop.md` 回環歷史。
- 藍本：DESIGN.md §7⑥。

- [x] **Step 1: frontmatter（逐字）**

```yaml
---
name: iterate
description: Triages verify findings or PR feedback, decides which stage to loop back to (max 3 rounds), and finishes when the stop condition is met. Use when starting the iterate stage of a loops-workflow run, or when a PR has reviewer feedback to act on.
---
```

- [x] **Step 2: body** 必含：
  - **debugging-and-error-recovery**：Stop-the-Line（STOP→PRESERVE→DIAGNOSE→FIX→GUARD→RESUME）、六步 Triage、根因修而非症狀修 + 每修加回歸測試。
  - doubt-driven **RECONCILE 四分類**（contract misread / actionable / trade-off / noise）。
  - 回環目標：回 build / plan / explore / goal，或**完工**（交 PR）。
  - **3 圈上限**：超過 escalate 給使用者；每次回環在 `loop.md` 記一筆。
  - 完工收尾用 Pre-Launch checklist 骨架（砍掉 infra）。三來源回饋（fix-from-pr）。停在 `iterate` 決策 gate。

- [x] **Step 3: 驗證 + Commit**

Run: `node -e "const s=require('fs').readFileSync('plugins/loops-workflow/skills/iterate/SKILL.md','utf8'); if(!/name: iterate/.test(s)||!/3/.test(s)) throw new Error('bad'); console.log('iterate OK')"`
```bash
git add plugins/loops-workflow/skills/iterate/SKILL.md
git commit -m "feat(iterate): debugging triage + RECONCILE 四分類 + 3 圈回環上限"
```

---

## Task 10: build persona（test-author / impl-author / referee）

**Files:**
- Create: `plugins/loops-workflow/agents/test-author.md`
- Create: `plugins/loops-workflow/agents/impl-author.md`
- Create: `plugins/loops-workflow/agents/referee.md`

**Interfaces:**
- Consumes: build skill 派遣（Task 7）。
- Produces: 三個 persona 名（`test-author` / `impl-author` / `referee`）—— build skill body 引用的就是這些名。

- [x] **Step 1: test-author.md**（frontmatter `name` + `description` + `tools`），body 規定：只依需求/契約 + TDD 品質判準寫 failing test；**禁止讀或寫 implementation**；回 test code + 「驗證哪條需求」。TDD 品質判準：Test State not Interactions、real over mocks、AAA、Prove-It。

- [x] **Step 2: impl-author.md**，body 規定：讀 test + plan，寫最小實作轉綠；**禁止改 test**；若認為 test 與需求不符，回報主線、不自行修改；綠燈後做 Refactor（Chesterton's Fence）。

- [x] **Step 3: referee.md**，body 規定：收到 test/impl 衝突時，依 `00-goal.md` 完工定義裁決是 test 錯還是 impl 錯，回判定 + 理由。

- [x] **Step 4: 驗證**

Run: `node -e "['test-author','impl-author','referee'].forEach(n=>{const s=require('fs').readFileSync('plugins/loops-workflow/agents/'+n+'.md','utf8'); if(!new RegExp('name: '+n).test(s)) throw new Error(n)}); console.log('build agents OK')"`
Expected: `build agents OK`。

- [x] **Step 5: Commit**

```bash
git add plugins/loops-workflow/agents/test-author.md plugins/loops-workflow/agents/impl-author.md plugins/loops-workflow/agents/referee.md
git commit -m "feat(agents): build 紅綠分離三 persona（test-author/impl-author/referee）"
```

---

## Task 11: verify persona（6 reviewer + finding-validator）

**Files:**
- Create: `plugins/loops-workflow/agents/product-contract-reviewer.md`
- Create: `plugins/loops-workflow/agents/architecture-reviewer.md`
- Create: `plugins/loops-workflow/agents/security-reviewer.md`
- Create: `plugins/loops-workflow/agents/performance-reviewer.md`
- Create: `plugins/loops-workflow/agents/code-quality-reviewer.md`
- Create: `plugins/loops-workflow/agents/tests-reviewer.md`
- Create: `plugins/loops-workflow/agents/finding-validator.md`

**Interfaces:**
- Consumes: verify skill 派遣（Task 8）。
- Produces: 7 個 persona 名 —— verify skill body 引用的就是這些名。對齊 cto-pr-reviewer 六角色 + validator。

- [x] **Step 1**：六 reviewer 各一檔，每檔 frontmatter（name/description/tools，唯讀）+ body 定義該軸 review scope（DESIGN.md §8.3 表）：
  - product-contract（issue 驗收/範圍/非目標）
  - architecture（分層邊界/import 方向/契約）
  - security（auth/注入/敏感資料 + **威脅建模/STRIDE/OWASP+LLM Top 10**，讀 security-checklist.md）
  - performance（query/N+1/index/transaction）
  - code-quality（錯誤處理/typing/**可讀性與簡潔**，含 code-simplification 反例）
  - tests-release（測試覆蓋/邊界/migration + **doubt-driven 反偏見：不給「作者說已通過」**）
  - 每個 reviewer 輸出 P0–P3 + Confidence + Route（讀 reviewer-severity.md）+ Metric-Honesty。

- [x] **Step 2**：finding-validator.md，body 規定：對每個候選 blocking finding 二輪確認（是否真實/是否本次引入/是否已被既有防護處理/修正方向是否對症），回 `validated`/`rejected`/`degraded`（讀 finding-validation.md）。

- [x] **Step 3: 驗證**

Run: `node -e "['product-contract-reviewer','architecture-reviewer','security-reviewer','performance-reviewer','code-quality-reviewer','tests-reviewer','finding-validator'].forEach(n=>{const s=require('fs').readFileSync('plugins/loops-workflow/agents/'+n+'.md','utf8'); if(!new RegExp('name: '+n).test(s)) throw new Error(n)}); console.log('verify agents OK')"`
Expected: `verify agents OK`。

- [x] **Step 4: Commit**

```bash
git add plugins/loops-workflow/agents/
git commit -m "feat(agents): verify 六 reviewer + finding-validator（對齊 cto-pr-reviewer）"
```

---

## Task 12: references — adapted from agent-skills

**Files:**
- Create: `plugins/loops-workflow/references/security-checklist.md`
- Create: `plugins/loops-workflow/references/code-simplification.md`

**Interfaces:**
- Consumes: 被 security-reviewer / code-quality-reviewer / build skill 讀取。
- 每檔頂部標 `<!-- adapted from addyosmani/agent-skills (MIT) -->`。

- [x] **Step 1: security-checklist.md** —— 萃取 agent-skills security-checklist + security-and-hardening：Threat Model First 四步、STRIDE 對照、OWASP Top 10 + LLM Top 10 對照表、pre-commit secret 掃描。敘述繁中。

- [x] **Step 2: code-simplification.md** —— 萃取 agent-skills code-simplification：Chesterton's Fence（改/刪前五問）、過度簡化四陷阱、紅旗「簡化需改 test = 改了行為」。敘述繁中。

- [x] **Step 3: 驗證**

Run: `node -e "['security-checklist','code-simplification'].forEach(n=>{const s=require('fs').readFileSync('plugins/loops-workflow/references/'+n+'.md','utf8'); if(!/adapted from addyosmani/.test(s)) throw new Error('缺 attribution: '+n)}); console.log('refs-mit OK')"`
Expected: `refs-mit OK`。

- [x] **Step 4: Commit**

```bash
git add plugins/loops-workflow/references/security-checklist.md plugins/loops-workflow/references/code-simplification.md
git commit -m "feat(references): security-checklist + code-simplification（adapted from agent-skills, MIT）"
```

---

## Task 13: references — borrow cto-pr-reviewer

**Files:**
- Create: `plugins/loops-workflow/references/reviewer-severity.md`
- Create: `plugins/loops-workflow/references/finding-validation.md`

**Interfaces:**
- Consumes: 被 6 reviewer + finding-validator 讀取。

- [x] **Step 1: reviewer-severity.md** —— P0/P1/P2/P3 定義 + Confidence 50/75/100 錨點 + Route（product-contract / engineering-safety）。對齊 cto-pr-reviewer 用語。

- [x] **Step 2: finding-validation.md** —— 二輪驗證判準：問題是否真實 / 是否本次引入 / 是否已被 caller·middleware·framework·既有防護處理 / 修正方向是否對症 → `validated`/`rejected`/`degraded`。

- [x] **Step 3: 驗證 + Commit**

Run: `node -e "['reviewer-severity','finding-validation'].forEach(n=>require('fs').readFileSync('plugins/loops-workflow/references/'+n+'.md')); console.log('refs-cto OK')"`
```bash
git add plugins/loops-workflow/references/reviewer-severity.md plugins/loops-workflow/references/finding-validation.md
git commit -m "feat(references): reviewer-severity + finding-validation（對齊 cto-pr-reviewer）"
```

---

## Task 14: references — 模板

**Files:**
- Create: `plugins/loops-workflow/references/goal-restate-schema.md`
- Create: `plugins/loops-workflow/references/task-template.md`
- Create: `plugins/loops-workflow/references/change-summaries.md`
- Create: `plugins/loops-workflow/references/adr-template.md`

- [x] **Step 1: goal-restate-schema.md** —— restate 六欄（Outcome / User / Why now / Success / Constraint / Out of scope）+ HYPOTHESIS+CONFIDENCE 欄。
- [x] **Step 2: task-template.md** —— Description / Acceptance / **Verification（具體指令）** / Dependencies / Files / Scope + 尺寸表 + 「該再拆」四訊號。
- [x] **Step 3: change-summaries.md** —— 三段式：CHANGES MADE / THINGS I DIDN'T TOUCH (intentionally) / POTENTIAL CONCERNS。
- [x] **Step 4: adr-template.md** —— Context / Decision / **Alternatives Considered（每候選 pros/cons + rejected 理由）** / Consequences。

- [x] **Step 5: 驗證 + Commit**

Run: `node -e "['goal-restate-schema','task-template','change-summaries','adr-template'].forEach(n=>require('fs').readFileSync('plugins/loops-workflow/references/'+n+'.md')); console.log('refs-tmpl OK')"`
```bash
git add plugins/loops-workflow/references/goal-restate-schema.md plugins/loops-workflow/references/task-template.md plugins/loops-workflow/references/change-summaries.md plugins/loops-workflow/references/adr-template.md
git commit -m "feat(references): goal/task/change-summary/adr 模板"
```

---

## Task 15: 整合 smoke test（跑一遍真迴圈）

**Files:**
- 無新檔（驗證整合）。可選 Create: `SMOKE.md`（記錄一次完整跑的軌跡）。

**Interfaces:**
- Consumes: 全部 skill + agents + references。

- [x] **Step 1: reload plugin**

在 Claude Code 裡 `/plugin marketplace add`（或 reload），確認 7 個 skill 全部出現在 skill 列表、7 個 agent 被自動發現。

- [x] **Step 2: 跑一個假任務的完整迴圈**

輸入 `/loops-workflow:dispatch 設計一個範例功能 X`（走 explore 起點，避免真改 code）。逐 gate 確認：
- dispatch 判為「設計問題」→ 建 `.loops/<slug>/loop.md` → 停。
- goal（若走到）產 `00-goal.md` restate 六欄 → 停 gate。
- explore 內外攤開比較 → `01-explore.md` → 停 gate。
- plan 任務拆解 → `02-plan.md` → 拍板 gate。
Expected: 每個階段都**停下等使用者**（驗證 Closed Loop）、`.loops/` 各檔依序生成、無自動串接。

- [x] **Step 3: 驗證 verify fan-out（針對一個小 build）**

對一個微小 build 跑到 verify，確認主線**同一回合派 6 個 reviewer Agent call**（並行）、validator 二輪、輸出 Ready/Not ready 寫 `04-verify.md`。
Expected: 6 reviewer + 1 validator 都被派、`.loops/04-verify.md` 有 P0–P3 分級。

- [x] **Step 4: 記錄 + Commit**

```bash
git add SMOKE.md
git commit -m "test: 完整迴圈 smoke test 通過（7 階段 gate + verify fan-out）"
```

---

## Self-Review（已執行）

- **Spec coverage**：DESIGN.md 7 階段 → Task 3-9；agents/（build 3 + verify 7）→ Task 10-11；references（adapted/borrow/模板）→ Task 12-14；骨架 + AGENTS.md → Task 1-2；smoke → Task 15。§11 YAGNI 項（commands/hooks/docs/Fleet/auto）刻意不建，正確。
- **Type/name consistency**：build skill 引用的 `test-author`/`impl-author`/`referee` = Task 10 建的名；verify 引用的 6 reviewer + `finding-validator` = Task 11 建的名；skill 引用的 reference 檔名 = Task 12-14 建的檔名。已對齊。
- **Placeholder scan**：frontmatter 全部逐字；SKILL.md body 以「必含結構 + DESIGN.md section 藍本」交付（prompt 工程的合理粒度，非 code 逐字）。
