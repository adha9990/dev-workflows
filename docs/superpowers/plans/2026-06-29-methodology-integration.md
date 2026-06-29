# 方法論融入（DDD/BDD/TDD/SDD → loops 一條鏈）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DDD/BDD/TDD/SDD 收斂成 loops 已有產物鏈的四個層——主力補 BDD（Given-When-Then 場景當 SDD↔TDD 連接組織）與 DDD（領域建模穿線），收緊 SDD traceability，TDD 不動。

**Architecture:** 純 SKILL/agents/references 散文編寫 + 一個預設旗標；新增一份 `references/bdd-scenarios.md` 當錨點，其餘檔案引用它並沿用其場景 ID 慣例（`S1…`）。無 runtime code、無自動測試——驗收＝跨檔一致性走查。

**Tech Stack:** Markdown（plugin 的 SKILL.md / agents/*.md / references/*.md）；無程式。

## Global Constraints

- 對外/內文一律**繁體中文**；code identifier / 路徑 / 指令 / skill 名保留英文。
- **場景 ID 慣例**：`S1`、`S2`…（issue 內唯一即可，純序號、不加前綴）。
- **GWT 是輕量純 markdown 文字，不引 Gherkin/Cucumber/.feature 工具**（規則 10）。
- **右尺寸鐵則**：方法論嚴格度隨 operation（`operation-first-move`）× size（XS–XL）縮放；瑣碎/refactor 免建模免場景、bug-fix 重現測試即場景、高風險才完整。**小任務不加 ceremony**。每個新增要求都要明寫這條 caveat。
- **TDD 不動**：build / test-rubric / operation-first-move 的既有語意不得改變。
- **不做（YAGNI）**：Gherkin 工具、property/mutation testing、Pact、OpenAPI 自動同步、完整 strategic design（ACL/context map）、three-amigos。
- subagent persona 讀 reference 用**絕對路徑**（AGENTS 規則：`${CLAUDE_PLUGIN_ROOT}` 在 markdown body 不展開）——新增交叉引用沿用既有寫法。
- repo：`C:\Users\Eagle\Documents\GitHub\dev-workflows`，branch `methodology-integration`（**不要切 branch**）。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 每個 edit 前**先 Read 該檔**，把新內容**融進既有結構與語氣**（不要破壞既有編號/章節）。

---

### Task 1：新增 `references/bdd-scenarios.md`（BDD 錨點，其餘任務都引用它）

**Files:**
- Create: `plugins/loops-workflow/references/bdd-scenarios.md`

**Interfaces:**
- Produces：GWT 格式定義、場景 ID 慣例（`S1…`）、兩條映射（→測試 Given/When/Then=Arrange/Act/Assert、→verify 閘逐條核）、右尺寸表。後續所有任務引用這份。

- [ ] **Step 1：逐字建立 `references/bdd-scenarios.md`**

````markdown
# BDD 行為情境（Given-When-Then）

> loops 用輕量 **Given-When-Then（GWT）場景**把「規格（SDD）」接到「測試（TDD）」與「驗收（verify）」。場景是 acceptance criterion 的可執行表達——**純 markdown 文字，不引 Gherkin / Cucumber / `.feature` 工具**（成本意識，AGENTS 規則 10）。

## 在方法論鏈的位置

```
領域語言(DDD) → 規格(SDD) → 行為情境 GWT(BDD) → 紅燈測試(TDD) → 實作 → 驗收回核(BDD+SDD)
```

GWT 是 SDD 與 TDD 之間的**連接組織**：`define`/`goal` 寫出場景 → `build` 的 test-author 從場景推紅燈測試 → `verify` 逐條核場景。

## 格式

每條場景一個 ID（`S1`、`S2`…，issue 內唯一即可、純序號不加前綴），三段：

```
S1（標題）
  Given <前置狀態 / 脈絡>
  When  <觸發的行為>
  Then  <可觀察、可斷言的預期結果>
```

- 用 ubiquitous language（DDD）的名詞寫，與 issue / DoD / code identifier / PR comment 同名（見 `clean-architecture.md` 的 Ubiquitous Language）。
- **一條場景一個行為**；多分支拆多條（happy / edge / failure 各一條）。
- Then 必須是**可觀察的結果**（回應/狀態/持久化），不是實作細節。

## 兩條映射

1. **→ 測試（TDD）**：`Given→Arrange、When→Act、Then→Assert`；測試名帶場景 ID（例 `test_S1_owner_can_delete`）。test-author 拿到場景就能推測試、不必猜需求。
2. **→ 驗收（verify）**：acceptance 閘逐條核「每個場景 ID 是否被滿足」，沿用五態（已滿足（有證據）/ 部分 / 缺失 / 證據不足 / 被反證）。

## 右尺寸（隨 operation × size 縮放，規則 10）

| 情境 | 場景數 |
|---|---|
| 瑣碎 / 純 refactor（不動行為） | 0（refactor 用 characterization test 釘現狀，見 `operation-first-move.md`） |
| bug-fix | **重現 bug 的那一條就是場景**（修前 Then 失敗、修後通過） |
| 一般 new-feature / change-behavior | happy + 關鍵 edge |
| 高風險 / 動到核心領域 | 完整場景集（含失敗模式 / 邊界） |

**小任務免 ceremony**：不要為一行修改硬寫三條場景。

## 與既有規範的關係（互補、不重複）

- `contract-spec.md`：contract 管**形狀**（API/資料/事件的結構、錯誤形狀、不變式）；場景管**行為**（什麼情境下發生什麼）。
- `test-rubric.md`：場景是 test-author 的**需求輸入**；test-rubric 管測試怎麼寫（四層 / Real>Fake>Stub>Mock / AAA）。
- `goal-restate-schema.md`：DoD 的 Success / 停止條件用場景表達（帶 ID），成為可逐條回核的完工核心。

## 範例（一般 new-feature）

```
S1 永久刪除：擁有者刪自己的 trash item
  Given 使用者 A 的 trash 內有 item X
  When  A 對 X 發 DELETE /api/trash/X
  Then  X 從儲存被永久移除，回 204，後續 GET 查不到

S2 不可刪他人（授權邊界）
  Given item X 屬於使用者 B
  When  使用者 A 對 X 發 DELETE /api/trash/X
  Then  回 403/404，X 仍在 B 的 trash（不被刪）
```

對應測試 `test_S1_owner_can_permanently_delete` / `test_S2_cannot_delete_others`；verify 閘逐條核 S1/S2。
````

- [ ] **Step 2：驗證內容齊全**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -c "Given\|When\|Then\|S1\|右尺寸\|不引" references/bdd-scenarios.md`
Expected: 非 0（含 GWT、ID、右尺寸、不引工具）。

- [ ] **Step 3：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/references/bdd-scenarios.md
git commit -m "docs(loops-workflow): add bdd-scenarios reference (GWT, lightweight)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2：`AGENTS.md §1` 加方法論鏈框定 + 右尺寸鐵則

**Files:**
- Modify: `AGENTS.md`（§1 設計取向，現有三個座標之後）

- [ ] **Step 1：Read `AGENTS.md` §1**，定位三個座標（類型 / 規模 / 目標脈絡）那段結尾。

- [ ] **Step 2：在 §1 三座標之後、§2 之前，加入這段**

```markdown
- **方法論鏈（DDD/BDD/TDD/SDD 各擁一個轉換、不重複，見對應 reference）**：loops 是一條 **Spec-Driven（SDD）** 的閉環——詞彙與結構由 **Domain-Driven（DDD，`references/clean-architecture.md` 的 Ubiquitous Language / entity·VO·aggregate / bounded context）** 塑形、驗收以 **Behavior-Driven（BDD，`references/bdd-scenarios.md` 的 Given-When-Then 場景）** 表達、實作由 **Test-Driven（TDD，build 紅綠 + `references/test-rubric.md`）** 保證。一條產物鏈：`領域語言(DDD) → 規格(SDD) → 行為情境 GWT(BDD) → 紅燈測試(TDD) → 實作 → 驗收回核(BDD+SDD)`；`.loops/` 的產物本身就是逐階提高解析度的規格（issue → `00-goal.md` → `02-plan.md` → tasks）。
  - **右尺寸鐵則**：方法論嚴格度隨 **operation（`references/operation-first-move.md`）× size（XS–XL）** 縮放——瑣碎 / 純 refactor 免建模免場景、bug-fix 的重現測試即場景、高風險 / 動到核心領域才完整 glossary + 場景集。**小任務不加 ceremony**（呼應規則 10 carve-out：砍非必要 ceremony、不砍 mandatory gate）。各階段 skill 依此框定、不各自重述。
```

- [ ] **Step 3：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows" && grep -c "方法論鏈\|右尺寸鐵則\|Given-When-Then" AGENTS.md`
Expected: 非 0。

- [ ] **Step 4：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add AGENTS.md
git commit -m "docs(loops-workflow): frame DDD/BDD/TDD/SDD chain + right-sizing in AGENTS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3：BDD 寫作側 —— `define` / `goal` / `goal-restate-schema` 用 GWT 場景

**Files:**
- Modify: `plugins/loops-workflow/skills/define/SKILL.md`（成功準則 / 驗收標準段）
- Modify: `plugins/loops-workflow/skills/goal/SKILL.md`（§3 restate / 停止條件段）
- Modify: `plugins/loops-workflow/references/goal-restate-schema.md`（停止條件 schema）

**Interfaces:**
- Consumes：`references/bdd-scenarios.md`（Task 1）的 GWT 格式 + `S1…` ID 慣例。
- Produces：issue / `00-goal.md` 的驗收以帶 ID 的 GWT 場景表達——成為 test-author 輸入與 verify 閘核對單位。

- [ ] **Step 1：Read 三檔**，定位 define 的「成功準則 / 驗收標準」、goal 的「restate 六欄 / 停止條件」、goal-restate-schema 的「停止條件 checkboxes」。

- [ ] **Step 2：`define/SKILL.md` 在「成功準則 / 驗收標準」處加一句**

```markdown
驗收標準用 **Given-When-Then 場景**寫（見 `references/bdd-scenarios.md`），每條給 ID（`S1`、`S2`…）；**右尺寸**：瑣碎 / bug-fix 從簡（bug-fix 一條重現場景即可），高風險才寫完整場景集。這些場景之後是 test-author 的輸入、verify acceptance 閘的核對項。
```

- [ ] **Step 3：`goal/SKILL.md` 在 restate 六欄 / 停止條件處加一句**

```markdown
DoD 的「Success / 停止條件」用 **GWT 場景（帶 ID `S1…`，見 `references/bdd-scenarios.md`）** 表達，讓完工定義可被 verify 逐條回核；沿用 issue 既有場景 ID、不重新編號。右尺寸同 `bdd-scenarios.md`（小任務不堆場景）。
```

- [ ] **Step 4：`references/goal-restate-schema.md` 的停止條件段加一句**

```markdown
停止條件以**場景 ID 對應的 checkbox**呈現（`- [ ] S1 …`），ID 與 issue/`bdd-scenarios.md` 一致——成為 verify acceptance 閘逐條勾稽、與 test 追溯的單一錨點。
```

- [ ] **Step 5：驗證三檔都引用了 bdd-scenarios**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -l "bdd-scenarios\|Given-When-Then\|GWT 場景" skills/define/SKILL.md skills/goal/SKILL.md references/goal-restate-schema.md`
Expected: 三個檔都列出。

- [ ] **Step 6：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/skills/define/SKILL.md plugins/loops-workflow/skills/goal/SKILL.md plugins/loops-workflow/references/goal-restate-schema.md
git commit -m "docs(loops-workflow): author acceptance as GWT scenarios in define/goal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4：BDD→TDD —— `agents/test-author.md` 從 GWT 場景推紅燈測試

**Files:**
- Modify: `plugins/loops-workflow/agents/test-author.md`

**Interfaces:**
- Consumes：`references/bdd-scenarios.md` 的映射 `Given→Arrange / When→Act / Then→Assert`、場景 ID。

- [ ] **Step 1：Read `agents/test-author.md`**，定位它描述「輸入 / 從需求或契約寫測試」的段落。

- [ ] **Step 2：在輸入 / 流程描述處加入**

```markdown
**若 issue / `00-goal.md` 有 GWT 場景（`references/bdd-scenarios.md`），以場景為主要輸入**：每條場景 `Given→Arrange、When→Act、Then→Assert`，**測試名帶場景 ID**（例 `test_S1_<行為>`），一條場景至少一個測試。場景沒涵蓋到的邊界仍依 `test-rubric.md` 補。沒有場景時（瑣碎 / 內部）退回既有「從需求 + 契約寫測試」。**不改變紅綠分離與 operation-first-move 起手式**（TDD 不動）。
```

- [ ] **Step 3：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -c "GWT 場景\|場景 ID\|Given→Arrange" agents/test-author.md`
Expected: 非 0。

- [ ] **Step 4：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/agents/test-author.md
git commit -m "docs(loops-workflow): test-author derives red tests from GWT scenarios

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5：BDD 驗收側 —— `verify` / `product-contract-reviewer` / `acceptance-review` 逐條核場景

**Files:**
- Modify: `plugins/loops-workflow/skills/verify/SKILL.md`（acceptance 閘 §4）
- Modify: `plugins/loops-workflow/agents/product-contract-reviewer.md`
- Modify: `plugins/loops-workflow/references/acceptance-review.md`

- [ ] **Step 1：Read 三檔**，定位 verify 的 acceptance 閘（逐條 AC 列五態）、product-contract-reviewer 的「逐句對 requirement」、acceptance-review 的端到端鏈路。

- [ ] **Step 2：`verify/SKILL.md` acceptance 閘處加一句**

```markdown
acceptance 閘的核對單位優先用 **GWT 場景 ID（`S1…`，見 `references/bdd-scenarios.md`）**：逐條場景列五態（已滿足（有證據）/ 部分 / 缺失 / 證據不足 / 被反證），並對到實作該場景的測試（測試名帶 ID）。無場景的 issue 退回逐句 AC（既有行為）。
```

- [ ] **Step 3：`agents/product-contract-reviewer.md` 加一句**

```markdown
若 issue / DoD 用 GWT 場景（`references/bdd-scenarios.md`），**逐條場景 ID 對照**「是否有對應測試 + 是否真被滿足」，而非只對散文句子；場景未被任何測試覆蓋＝缺口。
```

- [ ] **Step 4：`references/acceptance-review.md` 加一句**

```markdown
端到端鏈路驗證以 GWT 場景為單位：每條場景的 `Given` 佈置好、`When` 真的觸發、`Then` 在真實鏈路（使用者動作→傳輸→服務→持久化→回顯）可觀察到。
```

- [ ] **Step 5：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -l "場景 ID\|GWT 場景\|bdd-scenarios" skills/verify/SKILL.md agents/product-contract-reviewer.md references/acceptance-review.md`
Expected: 三個檔都列出。

- [ ] **Step 6：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/skills/verify/SKILL.md plugins/loops-workflow/agents/product-contract-reviewer.md plugins/loops-workflow/references/acceptance-review.md
git commit -m "docs(loops-workflow): verify acceptance gate checks GWT scenarios by ID

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6：DDD 穿線 —— `clean-architecture` / `design-plan-schema` / `explore` / `architecture-reviewer`

**Files:**
- Modify: `plugins/loops-workflow/references/clean-architecture.md`（補 DDD 詞彙）
- Modify: `plugins/loops-workflow/references/design-plan-schema.md`（§3 名詞說明升格）
- Modify: `plugins/loops-workflow/skills/explore/SKILL.md`（收斂式加 BC 辨識）
- Modify: `plugins/loops-workflow/agents/architecture-reviewer.md`（加審查軸）

- [ ] **Step 1：Read 四檔**，定位 clean-architecture 的分層段、design-plan-schema 的 §3 名詞說明、explore 收斂式評估段、architecture-reviewer 的審查清單。

- [ ] **Step 2：`clean-architecture.md` 末尾加一節**

```markdown
## Domain-Driven 詞彙（右尺寸，只在碰領域概念時）

- **Ubiquitous Language**：同一個領域概念，在 issue / DoD 場景 / glossary / code identifier / PR comment **用同一個名詞**。命名漂移＝缺陷（architecture-reviewer 會抓）。
- **Entity / Value Object / Aggregate**：設計動到領域物件時顯式分類——Entity（有 ID、可變、生命週期）/ Value Object（無 ID、不可變、以值相等）/ Aggregate（一致性邊界 + root，外部只透過 root 操作、不變式在邊界內維持）。
- **Bounded Context（BC）**：同一名詞在不同脈絡可能意義不同；跨 BC 邊界要明確（探索時辨識，見 explore）。
- **右尺寸**：瑣碎 / 純 refactor / 不碰領域的改動**跳過**這些；新功能命名動到的物件即可，高風險 / 核心領域才完整建模。不對小任務加 ceremony（規則 10）。
```

- [ ] **Step 3：`design-plan-schema.md §3 名詞說明` 升格為 Ubiquitous Language glossary**，在 §3 描述加入

```markdown
§3 是 **Ubiquitous Language glossary**：白話定義每個領域名詞，並（碰領域時）標 **〔Entity〕/〔VO〕/〔Aggregate〕**。這些名詞是 living 的單一真相源——issue / DoD 場景 / code identifier / PR 一律沿用同名（不一致由 architecture-reviewer 抓）。右尺寸：不碰領域的改動 §3 可從簡。
```

- [ ] **Step 4：`explore/SKILL.md` 收斂式評估處加一步**

```markdown
**辨識 bounded context / 既有 domain model**：摸架構時先確認這次改動落在哪個領域脈絡、有沒有既有的 domain model 可重用（reuse 優先，見 `reuse-check.md`）；跨 BC 邊界要標出來。右尺寸：瑣碎改動跳過。產出的領域名詞交給 plan 的 §3 glossary。
```

- [ ] **Step 5：`agents/architecture-reviewer.md` 審查清單加一軸**

```markdown
- **Ubiquitous Language 一致性 + BC 邊界**：code identifier 是否與 issue / DoD 場景 / `02-plan.md §3` glossary 同名（命名漂移＝缺陷）；領域物件的 Entity/VO/Aggregate 落點是否正確、跨 bounded context 的依賴是否明確（見 `clean-architecture.md` Domain-Driven 詞彙）。右尺寸：未碰領域的改動不強求。
```

- [ ] **Step 6：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -l "Ubiquitous Language\|Aggregate\|bounded context\|Bounded Context" references/clean-architecture.md references/design-plan-schema.md skills/explore/SKILL.md agents/architecture-reviewer.md`
Expected: 四個檔都列出。

- [ ] **Step 7：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/references/clean-architecture.md plugins/loops-workflow/references/design-plan-schema.md plugins/loops-workflow/skills/explore/SKILL.md plugins/loops-workflow/agents/architecture-reviewer.md
git commit -m "docs(loops-workflow): thread DDD (ubiquitous language, BC, aggregates)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7：SDD 收緊 traceability —— `task-template` 引用場景 ID + `plan` machine-plan 預設

**Files:**
- Modify: `plugins/loops-workflow/references/task-template.md`（Acceptance 欄）
- Modify: `plugins/loops-workflow/skills/plan/SKILL.md`（machine-plan 預設說明）

- [ ] **Step 1：Read 兩檔**，定位 task-template 的 Acceptance / Verification 欄、plan SKILL 的 machine-plan（machine-plan-schema 可選）段。

- [ ] **Step 2：`task-template.md` 的 Acceptance 欄加一句**

```markdown
Acceptance 條件**引用對應的 GWT 場景 ID**（`滿足 S1、S2`），讓 `場景 ID → task → 測試名（test_S1_…）→ verify 閘` 串成一條可追溯的線（SDD traceability）。無場景的內部任務照舊寫 pass/fail。
```

- [ ] **Step 3：`plan/SKILL.md` machine-plan 段把預設改為**

```markdown
**機器可驗證計畫塊（machine-plan）**：**有跨介面 contract-spec 時預設開**（task 有可執行 verification、acceptance ≤3、deps 無環，進 build 前 `validate-plan.mjs` 驗）；純內部 / 無對外契約的改動維持選用。
```

- [ ] **Step 4：驗證**

Run: `cd "/c/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow" && grep -c "場景 ID\|traceability" references/task-template.md && grep -c "預設開\|machine-plan" skills/plan/SKILL.md`
Expected: 皆非 0。

- [ ] **Step 5：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/references/task-template.md plugins/loops-workflow/skills/plan/SKILL.md
git commit -m "docs(loops-workflow): tighten SDD traceability (scenario-id thread, machine-plan default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8：文件同步 —— `docs/FLOW.md` + `docs/REFERENCES.md`

**Files:**
- Modify: `plugins/loops-workflow/docs/FLOW.md`
- Modify: `plugins/loops-workflow/docs/REFERENCES.md`

- [ ] **Step 1：Read 兩檔**，定位 FLOW 的各階段表 / §9 橫切面、REFERENCES 的分類目錄。

- [ ] **Step 2：`docs/FLOW.md` §9 橫切面加一列（或一段）描述方法論鏈**

```markdown
| **方法論鏈** | SDD（`.loops/` 逐階規格）/ DDD（`clean-architecture` Ubiquitous Language·Aggregate·BC）/ BDD（`bdd-scenarios` GWT，define/goal 寫·build 推測試·verify 核）/ TDD（build 紅綠） | 四者各擁產物鏈一個轉換、右尺寸縮放 |
```

並在總流程說明處補一句：各階段被哪個方法論強化見 `AGENTS.md §1` 方法論鏈框定。

- [ ] **Step 3：`docs/REFERENCES.md` 新增 `bdd-scenarios.md` 索引**，放在測試/規格相關分類，描述「BDD GWT 行為情境（輕量、連接 SDD↔TDD）」；並更新 `clean-architecture.md`（補 DDD 詞彙）、`design-plan-schema.md`（§3 升格 glossary）、`goal-restate-schema.md`（場景 ID）的描述。

- [ ] **Step 4：驗證 + 全域一致性走查（本案的「驗收」核心）**

Run（場景 ID 慣例一致、四檔鏈接得起來）：
```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows/plugins/loops-workflow
echo "=== 引用 bdd-scenarios 的檔（應含 define/goal/test-author/verify/product-contract/acceptance-review）==="
grep -rl "bdd-scenarios" skills agents references docs
echo "=== 方法論鏈框定在 AGENTS ==="
grep -c "方法論鏈" ../../AGENTS.md
echo "=== REFERENCES 有索引 bdd-scenarios ==="
grep -c "bdd-scenarios" docs/REFERENCES.md
```
Expected: bdd-scenarios 被多檔引用、AGENTS 有框定、REFERENCES 有索引。

走查（人工，必做）：抽一條 GWT 場景 `S1`，確認它能從 `define`（寫）→`goal`（DoD 沿用）→`plan` task acceptance（引用 S1）→`test-author`（test_S1_…）→`verify` 閘（核 S1）一路串起來、名詞一致、且每處都標了右尺寸 caveat。

- [ ] **Step 5：Commit**

```bash
cd C:/Users/Eagle/Documents/GitHub/dev-workflows
git add plugins/loops-workflow/docs/FLOW.md plugins/loops-workflow/docs/REFERENCES.md
git commit -m "docs(loops-workflow): sync FLOW + REFERENCES for methodology chain

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：**
- §A 憲法框定 → Task 2。
- §B BDD（bdd-scenarios 新檔 / define/goal/goal-restate / test-author / verify+product-contract+acceptance-review）→ Task 1, 3, 4, 5。
- §C DDD（clean-architecture / design-plan-schema §3 / explore / architecture-reviewer）→ Task 6。
- §D SDD（task-template 場景 ID 線 / plan machine-plan 預設）→ Task 7。
- §E 右尺寸 → 寫進 bdd-scenarios（Task 1）、AGENTS（Task 2），且每個新增段落都帶 caveat（Task 3–7 各 step 明寫）。
- §F 文件同步 → Task 8。
- §G 不做 → Global Constraints 明列。

**Placeholder scan：** 無 TBD/TODO；每個 edit step 都附**實際要寫入的完整 prose 區塊** + 放置 anchor + Read-first 指示；驗證步用具體 grep。

**一致性：** 場景 ID 慣例 `S1…` 在 Task 1/3/4/5/7 一致；`bdd-scenarios.md` 路徑在所有引用任務一致；右尺寸 caveat 在所有新增處重申；TDD 不動在 Task 4 明寫（不改紅綠分離 / operation-first-move）。

**執行性質：** 無自動測試——驗收＝跨檔一致性 grep（各 task Step）+ Task 8 的端到端場景走查。最終 whole-branch review 著重：四條鏈接得起、名詞/格式一致、右尺寸無違反、繁中、既有 TDD/SDD 機制未退化。
