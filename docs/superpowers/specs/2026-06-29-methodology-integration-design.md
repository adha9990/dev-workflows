# 設計：把 DDD / BDD / TDD / SDD 收斂成 loops 的一條方法論鏈（Targeted）

> 狀態：草案（待使用者過目）｜日期：2026-06-29｜branch：methodology-integration｜範圍：`plugins/loops-workflow` SKILL/agents/references + 根 `AGENTS.md`

## 1. 問題與目標

使用者要把 DDD / BDD / TDD / SDD 四種軟體工程開發模式融入 loops engineering，用以統一、優化、強化流程。

盤點（見 §2）顯示：**這四者不是要平行外掛的四套流程，而是 loops 已在跑的「同一條產物鏈」的四個層**——只是有的完整、有的只剩雛形、彼此沒接成一條線。

**統一模型（融入後的結果）：**

> loops 是一條「**規格驅動（SDD）**」的閉環——它的**詞彙與結構由「領域建模（DDD）」**塑形、它的**驗收以「行為情境（BDD）」**表達、它的**實作由「測試驅動（TDD）」**保證。

對應一條連續、無重複的產物鏈，每個方法論只擁有其中一個轉換：

```
領域語言(DDD) → 規格(SDD) → 行為情境 GWT(BDD) → 紅燈測試(TDD) → 實作 → 驗收回核(BDD+SDD)
```

**範圍（使用者已拍板）**：**Targeted 補缺口**，**聚焦 BDD + DDD**（SDD 只收緊 traceability、TDD 不動）。

## 2. 現況盤點（grounded）

| 方法論 | 現況 | 主要缺口 |
|---|---|---|
| **TDD** | ✅ 完整：build 紅綠分離、`operation-first-move` 四起手式、`test-rubric` 四層、Prove-It、Real>Fake>Stub>Mock | 進階（property/mutation testing）—— 本案視為 YAGNI、不做 |
| **SDD** | ✅ 脊椎已在：`00-goal.md`/`02-plan.md`/`contract-spec`/`machine-plan-schema`+`validate-plan.mjs` | machine-plan 預設關；AC↔task↔test 無形式化 traceability |
| **DDD** | 🟡 部分：clean-architecture（依賴向內/ports/screaming）、`§3 名詞說明`雛形、invariant | 無 bounded context 辨識、無 entity/VO/aggregate 顯式分類、ubiquitous language 不跨階段追蹤 |
| **BDD** | 🟡 最弱：goal 六欄 DoD、verify acceptance 閘五態、product-contract 逐句對 | 無 Given-When-Then 格式、AC 是散文、test-author 輸入非結構化場景、AC→test 無追蹤 |

結論：**TDD 已完整、SDD 已是骨幹（差收緊）、DDD/BDD 只有雛形——BDD 最弱卻又是把四者串成一條線的關鍵連接組織。**

## 3. 設計（逐節）

### §A 憲法層框定（`AGENTS.md §1` 設計座標）
在 §1 設計座標補一段：把四者定位成上面那條鏈、各擁一個轉換；並立 **右尺寸原則**（嚴格度隨 operation × size 縮放，見 §E）。**只加框定、不改既有 12 條規則的語意。**

### §B BDD —— GWT 當「規格↔測試」的連接組織（主力）

- **新增 `references/bdd-scenarios.md`**：
  - 輕量 **Given-When-Then** 格式（**純 markdown 文字、不引 Gherkin/.feature 工具**）。
  - 場景編號 `S1 / S2 …`（同時就是 acceptance criterion 的 ID，traceability 錨點）。
  - 右尺寸規則（§E）。
  - 兩條映射：① `Given→Arrange / When→Act / Then→Assert`（給 test-author）；② 每條場景 = verify acceptance 閘的核對項。
  - 與既有的關係：場景是 `test-rubric` 的「需求輸入」、是 `contract-spec` 的行為面補充（contract 管形狀、scenario 管行為）。
- **`skills/define/SKILL.md`**：issue 的成功準則 / 驗收標準改用 **GWT 場景**寫（右尺寸）；引用 `bdd-scenarios.md`。
- **`skills/goal/SKILL.md` + `references/goal-restate-schema.md`**：DoD 的「Success / 停止條件」表達成**帶 ID 的 GWT 場景**（成為可逐條回核的完工核心）。
- **`agents/test-author.md`**：輸入由「需求/契約」→「**GWT 場景 + 契約**」；指示「有場景就 Given→Arrange、When→Act、Then→Assert 推測試，測試名帶場景 ID」。
- **`skills/verify/SKILL.md`（acceptance 閘 §4）+ `agents/product-contract-reviewer.md` + `references/acceptance-review.md`**：逐條核「每個場景 ID 是否被滿足」（沿用既有五態，只是核對單位從散文 AC 變成場景）。

### §C DDD —— 領域建模穿線（次要）

- **擴充 `references/clean-architecture.md`**（不另拆檔，減少檔數）：補 **ubiquitous language、entity / value object / aggregate 分類、bounded context** 概念——右尺寸（只在碰領域概念時要求）。
- **`references/design-plan-schema.md §3 名詞說明` → 升格 Ubiquitous Language glossary**：顯式標 entity/VO/aggregate；立**跨階段一致紀律**（issue / DoD / code identifier / PR comment 用同一套名詞）。
- **`skills/explore/SKILL.md`（收斂式）**：加一步「辨識 bounded context / 既有 domain model（reuse 優先）」。
- **`agents/architecture-reviewer.md`**：加「**名詞一致性**（code 與 glossary/issue 同名）+ BC 邊界」審查軸。

### §D SDD —— 收緊 traceability（輕量、不引新工具）

- **一條 ID 線**：`define` 場景 ID（S1…）→ `goal` DoD 沿用同 ID → `plan` task 的 acceptance 引用場景 ID（`task-template.md` 的 Acceptance 欄）→ 測試名帶 ID → `verify` 閘按 ID 核。場景 ID = AC ID = test 標籤，單一錨點貫穿。
- **machine-plan 預設**：`skills/plan/SKILL.md §5` 改為「**有跨介面 contract-spec 時預設開** machine-plan 塊」，其餘維持選用（一行預設說明改）。

### §E 右尺寸規則（規則 10 的硬約束，寫進 §A 框定 + `bdd-scenarios.md` + `clean-architecture.md`）

| 情境（operation × size） | DDD 建模 | BDD 場景 |
|---|---|---|
| 瑣碎 / 純 refactor（不動行為） | 跳過 | 0（refactor 用 characterization test 釘現狀） |
| bug-fix | 跳過（除非牽動領域） | **重現 bug 的那條就是 GWT 場景** |
| 一般 new-feature / change-behavior | 命名動到的 entity/VO + glossary 增補 | happy + 關鍵 edge |
| 高風險 / 動到核心領域 | 完整：aggregate 邊界 + BC + glossary | 完整場景集（含失敗模式） |

### §F 文件同步
- `docs/FLOW.md`：各階段表加「方法論層」標註（哪階段被哪個方法論強化）；§9 橫切面補方法論鏈一列。
- `docs/REFERENCES.md`：新增 `bdd-scenarios.md` 索引、更新 clean-architecture / design-plan-schema / goal-restate-schema 的描述。

### §G 明確不做（YAGNI）
Gherkin/Cucumber/.feature 工具、property-based / mutation testing、Pact 消費者契約、OpenAPI 自動同步、完整 DDD strategic design（ACL / context map 重儀式）、three-amigos 機制。要的話另案。

## 4. 受影響檔案清單

**新增**：`references/bdd-scenarios.md`

**修改**：
`AGENTS.md`、`skills/define/SKILL.md`、`skills/goal/SKILL.md`、`skills/explore/SKILL.md`、`skills/plan/SKILL.md`、`skills/verify/SKILL.md`、`agents/test-author.md`、`agents/product-contract-reviewer.md`、`agents/architecture-reviewer.md`、`references/goal-restate-schema.md`、`references/clean-architecture.md`、`references/design-plan-schema.md`、`references/acceptance-review.md`、`references/task-template.md`、`docs/FLOW.md`、`docs/REFERENCES.md`

## 5. 執行性質與驗收

幾乎全是 SKILL / agent / reference 的**散文編寫 + 一個預設旗標**，無 runtime code / 無 TDD 紅綠。驗收重點＝**一致性**：
1. 名詞/格式一致：GWT 格式、場景 ID 慣例（S1…）在 define/goal/plan/build/verify/test-author 各處寫法一致。
2. 鏈接得起來：場景 ID 從 define → goal → plan task → test → verify 閘真的串成一條（抽一個範例走查）。
3. 右尺寸沒被違反：每處要求都標明「隨 operation×size 縮放、小任務免 ceremony」（規則 10）。
4. 不破壞既有：TDD（build/test-rubric）語意不動；SDD 既有機制不退化；繁中對外。
5. 交叉引用正確：新 `bdd-scenarios.md` 被 define/goal/test-author/verify 正確引用（subagent persona 用絕對路徑，見 AGENTS 規則 §references 解析）。

## 6. 交付
branch `methodology-integration` → 逐檔改 → 一致性走查 → PR（使用者 review 後 squash merge）。設計 spec / 計畫依前例**不進 PR**（branch 歷史留痕，squash 後 master 不含）。

## 7. 待實作時再定的小細節（不阻擋拍板）
- 場景 ID 命名：`S1/S2`（每 issue 從 1 起）vs 帶 issue 前綴。傾向純 `S1…`（簡潔、issue 內唯一即可）。
- `bdd-scenarios.md` 是否附 1 個完整範例（happy+edge+failure）—— 傾向附，當作 test-author/verify 的共同樣板。
- DDD glossary 放 `02-plan.md §3` 還是獨立小節 —— 傾向沿用 §3、只升格內容。
