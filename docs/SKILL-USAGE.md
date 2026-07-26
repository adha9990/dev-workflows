# skill／reference 實際載入度

> **這份是某一次量測的紀錄，不是永久說明。** 它回答一句話：規則寫在 skill 裡，實際跑的時候**有沒有被載入**。
> 重現：`node plugins/loops-workflow/scripts/skill-usage.mjs --report`（預設吃已安裝 plugin 的最新版快照與本機 transcript）。

快照：`0.56.4`（11 個 skill、73 份 reference，其中 47 份有 skill 宣稱會用到）

## 分母

| 掃到的 transcript | 算進分母（loop session） | 排除：非 loop | 排除：版本對不上 |
|---|---|---|---|
| 74 | 7 | 67 | 0 |

> 大部分 session 根本不是在跑 loop。把它們算進分母會得出嚇人但無意義的比例，所以**明確排除並計數**。

## 逐 session

分母裡有 **5 個 session 碰過 loop 的檔案、卻一次 skill 都沒叫**——那本身就是訊號，不能被聚合數字蓋掉。

| session | skill 呼叫 | 叫到哪些 | reference 載入（去重） | loop 檔動作 | 子代理檔 |
|---|---|---|---|---|---|
| `api-auto-score-system/ce14600b` | 7 | `build`、`explain`、`explore`、`goal`、`iterate`、`plan`、`verify` | 13（4） | 57 | 25 |
| `dev-workflows/14b1162e` | 5 | `build`、`dispatch`、`explore`、`goal`、`plan` | 70（23） | 1130 | 71 |
| `dev-workflows@180-docs/2f662561` | 0 | （無） | 0（0） | 4 | 0 |
| `dev-workflows@181-hardening/bd4aa113` | 0 | （無） | 0（0） | 4 | 0 |
| `dev-workflows@183-dual-harness-compat-layer/3298b2aa` | 0 | （無） | 0（0） | 6 | 0 |
| `dev-workflows@183-dual-harness-compat-layer/89d341a0` | 0 | （無） | 0（0） | 4 | 0 |
| `dev-workflows/116c3b1d` | 0 | （無） | 3（3） | 17 | 0 |

## skill 被叫到幾次

| skill | 呼叫次數 | 出現在幾個 session |
|---|---|---|
| `build` | 2 | 2 |
| `explore` | 2 | 2 |
| `goal` | 2 | 2 |
| `plan` | 2 | 2 |
| `dispatch` | 1 | 1 |
| `explain` | 1 | 1 |
| `iterate` | 1 | 1 |
| `verify` | 1 | 1 |

### 一次都沒被叫到的 skill

- `clarify`
- `define`
- `scaffold-fullstack`

## reference 被載入幾次

| reference | 載入次數 | 出現在幾個 session |
|---|---|---|
| `journaling.md` | 14 | 1 |
| `reviewer-severity.md` | 10 | 1 |
| `interaction-adapter.md` | 8 | 1 |
| `comment-policy.md` | 6 | 2 |
| `model-effort-policy.md` | 6 | 1 |
| `reuse-check.md` | 6 | 2 |
| `test-rubric.md` | 5 | 1 |
| `context-diet.md` | 4 | 1 |
| `auto-mode.md` | 3 | 2 |
| `clean-code.md` | 3 | 1 |
| `pr-spec.md` | 3 | 1 |
| `bdd-scenarios.md` | 2 | 1 |
| `eval-harness.md` | 2 | 1 |
| `outbound-templates.md` | 2 | 2 |
| `accessibility-reviewer.md` | 1 | 1 |
| `adr-template.md` | 1 | 1 |
| `clean-architecture.md` | 1 | 1 |
| `code-simplification.md` | 1 | 1 |
| `contract-spec.md` | 1 | 1 |
| `docs-policy.md` | 1 | 1 |
| `edd-comment-template.md` | 1 | 1 |
| `eval-judge-panel.md` | 1 | 1 |
| `finding-validator.md` | 1 | 1 |
| `goal-restate-schema.md` | 1 | 1 |
| `security-checklist.md` | 1 | 1 |
| `security-reviewer.md` | 1 | 1 |

### 有 skill 宣稱會用、但一次都沒被載入

**這一節是本報告的重點**：規範寫了、skill 也指名了，但實際跑的時候從來沒讀進去。

| reference | 哪些 skill 宣稱會用它 |
|---|---|
| `acceptance-review.md` | `iterate`、`verify` |
| `architecture-review.md` | `verify` |
| `change-summaries.md` | `build` |
| `code-retrieval.md` | `explore`、`verify` |
| `commit-spec.md` | `build` |
| `correctness-review.md` | `verify` |
| `cross-model-review.md` | `iterate` |
| `design-patterns.md` | `plan`、`verify` |
| `design-plan-schema.md` | `plan` |
| `docs-devex-review.md` | `verify` |
| `finding-author-decision-rule.md` | `verify` |
| `finding-validation.md` | `verify` |
| `fleet.md` | `explore`、`plan` |
| `machine-plan-schema.md` | `plan` |
| `multi-user-review.md` | `verify` |
| `onboarding.md` | `explore` |
| `operation-first-move.md` | `build`、`define`、`dispatch`、`goal` |
| `optional-reviewers.md` | `verify` |
| `performance-review.md` | `verify` |
| `pr-feedback-sources.md` | `iterate` |
| `preflight.md` | `verify` |
| `project-conventions.md` | `goal`、`plan`、`verify` |
| `quality-gate-schema.md` | `build` |
| `refactoring.md` | `build`、`verify` |
| `review-dispositions.md` | `verify` |
| `root-cause-review.md` | `verify` |
| `task-template.md` | `build`、`plan` |
| `ui-interaction-review.md` | `verify` |
| `verify-triage.md` | `verify` |

### 被載入、但沒有任何 skill 正文提到它

反向訊號：實際依賴沒寫進 skill 正文（或是由 agent／hook 直接指路的）。

- `interaction-adapter.md`
- `eval-harness.md`
- `outbound-templates.md`
- `accessibility-reviewer.md`
- `edd-comment-template.md`
- `eval-judge-panel.md`
- `finding-validator.md`
- `security-reviewer.md`

## 這份報告不回答什麼

- **不回答「載入了有沒有照做」**。那是另一層；要先看完這裡的差集，才知道值不值得投資語意評測。
- **不宣稱某條規則沒用**。一份 reference 從沒被載入，可能是機制沒接上、也可能是它本來就不需要——那是人的判斷。

## 怎麼讀這份報告

一份 reference 出現在「宣稱會用、但一次都沒被載入」，只有兩種可能，而且**修法相反**：

| 可能 | 怎麼判斷 | 修法 |
|---|---|---|
| **機制沒接上** | 該 skill 明明有跑（上面的逐 session 表看得到），reviewer 也派了，但那份規範沒被讀 | 修載入路徑：把「請自行讀」改成明確指令、或把該規則降到 hook／狀態閘 |
| **它其實不需要** | 該規則從來沒有影響過任何判斷，也沒人抱怨過它沒生效 | 刪掉——規則只增不減，本身就是成本 |

**這份報告不替你判斷是哪一種。** 它只提供事實。
