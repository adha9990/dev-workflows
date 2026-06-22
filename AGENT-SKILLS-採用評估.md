# agent-skills 全資產採用評估 —— loops-workflow

> 對 `addyosmani/agent-skills` 的**全部 35 個資產**(24 skill + 4 persona + 5 reference + docs/agents + orchestration）做逐項深入評估，決定哪些借進 loops-workflow。方法：repo clone 在本地，派 5 個 agent 並行**完整讀過每個檔案**（非憑描述猜），各自產出結構化評估，再綜合。
>
> 日期：2026-06-22。落點：跟 `DESIGN.md`、`RESEARCH-agent-skills.md` 並列。

---

## 貫穿全部的一條判準

**重複的借螺絲、缺口的整支採用。**

重心是 work-plugins。凡 agent-skills 的東西**跟 work-plugins 已有的 skill 重疊**（review / refactor / test / commit / pr / feature-docs…），一律只抽「它有、我沒有」的那幾顆螺絲，**不整支搬進來變第二套規範**（否則跟重心打架）。只有**填補 work-plugins 真缺口**的，才整支採用。

這也直接回答「那些很強的 skill 為什麼不全收」：強 ≠ 該收，**和既有資產不重複**才是該不該整支收的判準。

---

## 校準更正（vs 初版，對齊 DESIGN.md §12）

初版（🟢12 / 🟡18 / 🔴6）在「先檢索 work-plugins 再評估」後校準成 🟢9 / 🟡17 / 🔴10。九項異動：

| 資產 | 初版 | 校準後 | 為什麼 |
|------|:---:|:---:|------|
| code-simplification | 🟡 | 🟢 | 初版誤以為撞 work-plugins 的 refactor；實際 work-plugins **無** refactor skill（refactor 是環境層 skill），這是真缺口 → 整支採用當 build Refactor step |
| using-agent-skills | 🟢 | 🟡 | 只借決策樹形式與共用守則位置，非整支搬 |
| interview-me | 🟢 | 🟡 | 訪談主體是 pm-feature-intake，這裡只借 HYPOTHESIS+CONFIDENCE / restate 六欄等零件 |
| planning-and-task-breakdown | 🟢 | 🟡 | 主體是 plan-from-issue，只借任務模板 / 尺寸表螺絲 |
| docs/agents.md | 🟢 | 🟡 | 編排主體是 cto-pr-reviewer，只借 fan-out 矩陣 + 不巢狀原則 |
| code-review-and-quality | 🟡 | 🔴 | 被 cto-pr-reviewer 六 reviewer + validator 涵蓋且更強 |
| code-reviewer（persona） | 🟡 | 🔴 | 同上，五軸 review 已是重心引擎 |
| test-engineer（persona） | 🟡 | 🔴 | 被 cto-pr-reviewer tests-reviewer + work-plugins:test 涵蓋 |
| web-performance-auditor | 🟡 | 🔴 | 前端特定；效能由 code-quality reviewer 條件性帶 |

校準後 🟢 整支採用 9 ＝ 真缺口 6 檔（code-simplification、security-auditor、security-checklist、debugging-and-error-recovery、source-driven-development、context-engineering）＋ 共用方法 3 檔（skill-anatomy、doubt-driven、orchestration-patterns）。

> 下方〈🟢 採用詳述〉/〈🟡 借螺絲〉的**借用內容仍有效**（要借的機制沒變）；只有「整支 vs 借螺絲」的標籤依本校準調整 —— using-agent-skills / interview-me / planning-and-task-breakdown / docs-agents 由「整支」降為「借螺絲」，code-simplification 由「借螺絲」升為「整支」。

---

## 總表（35 資產）

| 資產 | 建議 | 階段 | 一句話 |
|------|:---:|------|--------|
| **using-agent-skills** | 🟡 | dispatch | 借決策樹形式 + 共用守則集中定義（不整搬，只借架構位置） |
| **interview-me** | 🟡 | goal | 借 HYPOTHESIS+CONFIDENCE / restate 六欄 / 95% 停止（主體是 pm-feature-intake） |
| **planning-and-task-breakdown** | 🟡 | plan | 借任務模板 / 尺寸表 / 該再拆四訊號（主體是 plan-from-issue） |
| **source-driven-development** | 🟢 | explore/plan | 外部框架查官方文件、引用來源紀律 |
| **debugging-and-error-recovery** | 🟢 | build/iterate | 失敗 triage（根因 vs 症狀、加回歸測試） |
| **security-auditor**（persona） | 🟢 | verify | 安全 reviewer（work-plugins 沒有） |
| **security-checklist**（ref） | 🟢 | verify | 安全稽核 baseline + OWASP/LLM Top 10 |
| **docs/agents.md** | 🟡 | verify/共用 | 借 fan-out 決策矩陣 + subagent 不巢狀（編排主體是 cto-pr-reviewer） |
| context-engineering | 🟢 | 共用 | （先前已評估）context 5 層 + <2000 行 |
| doubt-driven-development | 🟢 | verify/iterate | （先前已評估）adversarial + 3 圈上限 |
| orchestration-patterns | 🟢 | 共用 | （先前已評估）fan-out + personas 不互呼叫 |
| skill-anatomy | 🟢 | 共用 | （先前已評估）skill 標準骨架 |
| code-review-and-quality | 🔴 | — | 被 cto-pr-reviewer 六 reviewer + validator 涵蓋且更強 |
| code-reviewer（persona） | 🔴 | — | 被 cto-pr-reviewer 涵蓋（五軸 review 已是重心引擎） |
| test-engineer（persona） | 🔴 | — | 被 cto-pr-reviewer tests-reviewer + work-plugins:test 涵蓋 |
| test-driven-development | 🟡 | build/verify | 借測試品質判準餵 test-author（紅綠循環已由雙 agent 承載） |
| testing-patterns（ref） | 🟡 | build/verify | 借 anti-patterns 表 + mock at boundaries |
| code-simplification | 🟢 | build/verify | 整支採用 Refactor step（work-plugins 無 refactor skill，refactor 是環境層 skill 非本 marketplace） |
| security-and-hardening | 🟡 | verify/plan | 借 Threat Model First 四步（具體碼領域特定） |
| performance-optimization | 🟡 | verify/iterate | 借 measure-first 五步 + 前後數字（CWV 閾值前端特定） |
| performance-checklist（ref） | 🟡 | verify | 借 Backend 反 pattern（N+1/索引），條件性 |
| web-performance-auditor（persona） | 🔴 | — | 前端特定；效能由 code-quality reviewer 條件性帶（Metric-Honesty 已抽為通用螺絲） |
| incremental-implementation | 🟡 | build | 借三種 slicing 策略（commit/scope 已覆蓋） |
| source 之外的 idea-refine | 🟡 | goal/explore | 借七種發散 lens + 隱藏假設三問（撞 brainstorming） |
| spec-driven-development | 🟡 | plan | 借 reframe 成 success criteria + living spec（撞 project-onboarding） |
| api-and-interface-design | 🟡 | plan | 借 Contract First 等四判準，條件式（領域特定） |
| browser-testing-with-devtools | 🟡 | verify | 借 UI bug 5 步閉環 + Clean Console（工具層已有） |
| git-workflow-and-versioning | 🟡 | 共用 | 借 Save Point + Change Summaries 三段式（commit 規範撞） |
| documentation-and-adrs | 🟡 | plan/共用 | 借 ADR Alternatives/Consequences 骨架（撞 feature-docs） |
| shipping-and-launch | 🟡 | iterate 收尾 | 借 Pre-Launch checklist 分類骨架（deploy 層過重） |
| frontend-ui-engineering | 🔴 | — | 純前端領域手冊，與語言無關定位衝突 |
| ci-cd-and-automation | 🔴 | — | pipeline 基建領域特定 |
| deprecation-and-migration | 🔴 | — | 特定任務類型，非每輪會走的階段 |
| observability-and-instrumentation | 🔴 | — | 後端 on-call 領域，scope 外 |
| accessibility-checklist | 🔴 | — | a11y 不在 verify 四維，前端窄 |
| observability-checklist | 🔴 | — | 同上，後端 on-call |

統計（work-plugins 校準後）：🟢 整支採用 **9**｜🟡 借螺絲 **17**｜🔴 不採用 **10**。
> 初版為 🟢12 / 🟡18 / 🔴6；校準後對齊 DESIGN.md §12，見下方〈校準更正〉。

---

## 🟢 採用詳述（填補 work-plugins 真缺口）

### dispatch
**using-agent-skills** — 三個可直接移植的機制：
1. **決策樹**：`Task arrives → ├ 條件 → skill` 的 ASCII 樹，支援巢狀分支。直接把葉節點換成「進哪個 loops 階段 + 讀哪個 `.loops/` 檔」。
2. **Core Operating Behaviors 集中定義**：把「全程不變的紀律」（繁中對外 / human gate 不可跳 / `.loops/` 每階段交接）集中寫在 dispatch，而非七階段各自重述。借的是「架構位置」不是逐條內容。
3. **線性 → 閉環的改寫**：它的 lifecycle 是線性終於 ship；我們要改成「iterate 後分叉：完工→交 PR、未完→回上游」。

### goal
**interview-me** — 補 work-plugins 最上游（issue 還沒成形那段，`plan-from-issue` 假設 issue 已存在）：
- HYPOTHESIS + CONFIDENCE 數字機制（寫進 `.loops/00-goal.md` 開頭）
- 一次一問 + 附猜測
- restate 六欄骨架（Outcome / User / Why now / Success / Constraint / **Out of scope**）當 goal markdown schema
- explicit-yes gate（「whatever you think ≠ yes」）= goal→explore 的 gate 條件
- 95% 信心停止條件

### plan
**planning-and-task-breakdown** — 補 work-plugins 缺的「拆解方法學」（`plan-from-issue` 重心在對齊與拍板，不是拆解）：
- 垂直 vs 水平切片（每片可獨立 verify，餵給 build 紅綠分離）
- 任務模板（Description / Acceptance / **Verification 含具體指令** / Dependencies / Files / Scope）當 `.loops/02-plan.md` 的任務 schema
- 任務尺寸表 XS–XL + 「該再拆」四訊號（>2hr、acceptance >3 條、跨 2+ 子系統、標題有 "and"）
- 依賴圖 + 每 2-3 任務一 checkpoint = build 內部 gate 位置

### explore / plan
**source-driven-development** — 補「外部框架決策有可驗證來源」紀律（與你「外部參考只有參考價值」「裝套件前先比較評估」同源）：
- DETECT→FETCH→IMPLEMENT→CITE 四步（FETCH 用 context7 MCP 落地）
- Source hierarchy（官方文件 > 官方 blog > web 標準；SO/blog/訓練資料不可當主來源）
- CITE 規則：附 URL + 深連結錨點、查不到明寫 `UNVERIFIED`
- docs 與既有 code 衝突 → surface 給使用者（接 human gate）

### build / iterate
**debugging-and-error-recovery** — 補「失敗怎麼扎實處理」（避免 iterate 變猜題打補丁）：
- Stop-the-Line（STOP→PRESERVE→DIAGNOSE→FIX→GUARD→RESUME）當 iterate 入口
- 六步 Triage（Reproduce→Localize→Reduce→Fix Root Cause→Guard→Verify）
- 症狀修 vs 根因修；每修加一條會紅→綠的回歸測試（呼應 verify 反偏見）
- 不可復現 bug 分類樹 + `git bisect`

### verify
**security-auditor（persona）+ security-checklist（ref）** — work-plugins **沒有**安全 reviewer，真缺口：
- 整支當 verify 的「安全維度 reviewer」
- 六域 scope + 從 trust boundary 起手用 STRIDE
- 五級 severity（Critical/High 附 PoC）
- AI/LLM 安全段（OWASP LLM Top 10）對做 Claude Code plugin 切題
- security-checklist 當 reviewer 逐項打勾的 baseline

**docs/agents.md** — verify 多 reviewer 的**編排藍本**：
- fan-out 決策矩陣（獨立才並行、有依賴就循序）
- 「並行各跑 fresh context → 主 agent merge 成 go/no-go」= verify→gate 形狀
- **subagent 不能巢狀** → verify 的 reviewer 必須主流程親自派（與 cto-pr-preflight 一致）
- persona 不互相呼叫，只在報告裡建議

---

## 🟡 借螺絲（不整搬 —— 跟 work-plugins 重疊或領域特定）

| 資產 | 借哪幾顆螺絲 | 為何不整搬 |
|------|------------|-----------|
| code-review-and-quality / code-reviewer | 五軸維度（correctness/readability/architecture/security/performance）、severity 標籤（Critical/Required/Nit/Optional/FYI）、輸出模板、「先讀 tests」 | 整套 review 流程撞 `review-from-issue` / `cto-pr-preflight` |
| test-engineer / test-driven-development / testing-patterns | 測試品質判準餵 test-author（Test State not Interactions、real over mocks、Prove-It、anti-pattern 表）、五類 scenario 表、覆蓋分析模板 | 紅綠循環已由雙 agent 承載；基建已由 `work-plugins:test` 覆蓋（語意品質互補） |
| code-simplification | Chesterton's Fence、過度簡化四陷阱、「簡化需改測試=改了行為」 | 整套撞 `refactor` skill |
| security-and-hardening | Threat Model First 四步、STRIDE 對照表、三層邊界 Ask First | 具體防呆碼領域特定 |
| performance-optimization / performance-checklist / web-performance-auditor | measure-first 五步、before/after 要數字、N+1/缺索引等跨棧反 pattern、**Metric-Honesty Rule**、**條件性派遣**（前端才派） | CWV 閾值與前端細節領域特定 |
| incremental-implementation | 三種 slicing（Vertical/Contract-First/Risk-First）、Keep It Compilable | commit/scope 已被 `commit`/`clean-architecture` 覆蓋 |
| idea-refine | 七種發散 lens、攤開隱藏假設三問、Not Doing list | 整套撞 `superpowers:brainstorming` |
| spec-driven-development | reframe 成 success criteria、living spec 紀律、surface assumptions | spec 六模板撞 `project-onboarding` |
| api-and-interface-design | Contract First、Prefer Addition、Validate at Boundaries（條件式） | REST/GraphQL 具體寫法領域特定 |
| browser-testing-with-devtools | UI bug 5 步閉環、Clean Console Standard、browser content 當 untrusted | 工具層已有 `run-eagle-app-core`/`chrome-devtools` |
| git-workflow-and-versioning | **Save Point Pattern**、**Change Summaries 三段式**（CHANGES/DIDN'T TOUCH/CONCERNS） | commit 規範撞 `work-plugins:commit`（繁中更細） |
| documentation-and-adrs | ADR 的 Alternatives Considered + Consequences 骨架 | 其餘撞 `feature-docs`/`commit` |
| shipping-and-launch | Pre-Launch checklist 分類骨架（砍掉 infra/DNS/CDN） | deploy/rollout 層對 PR 流程過重 |

**最值得抽的兩顆通用螺絲**（套到所有 verify reviewer）：
1. **Metric-Honesty Rule**（沒實跑就標 `not measured` / `potential impact`，不准假裝量過）—— 呼應你「verify 由 Claude 親自代跑真 app」。
2. **Change Summaries 三段式**（CHANGES / DIDN'T TOUCH intentionally / CONCERNS）—— 現成的 build→verify 階段交接 markdown 模板。

---

## 🔴 不採用（領域太窄 / scope 外）

| 資產 | 為何不採用 |
|------|-----------|
| frontend-ui-engineering | 純前端領域手冊（React/Tailwind/WCAG），與「語言/領域無關閉環」定位衝突 |
| ci-cd-and-automation | GitHub Actions/部署/Dependabot 基建，是設定教學非流程紀律 |
| deprecation-and-migration | 汰換/遷移是特定任務類型，非每輪迭代會走的階段 |
| observability-and-instrumentation | 後端 on-call 領域（OTel/Prometheus/SLO），scope 外 |
| accessibility-checklist | a11y 不在 verify 四維，前端適用面窄，多數任務變噪音 |
| observability-checklist | 同上，後端 on-call |

> 共同理由：硬塞進七階段任一格都會在多數任務變噪音，違反 agent-skills 自己「避免無關維度造成 fan-out 噪音」的原則。需要時當可獨立觸發的領域 skill 即可。

---

## 對 DESIGN.md 的影響（待拍板後整合）

採用後各階段會長厚：

- **dispatch**：以 `using-agent-skills` 決策樹為藍本 + Core Operating Behaviors 集中定義
- **goal**：`interview-me` 的 intent extraction（HYPOTHESIS+CONFIDENCE、restate 六欄、explicit-yes gate）
- **explore**：`source-driven-development`（外部框架查官方文件）+ idea-refine 七 lens
- **plan**：`planning-and-task-breakdown` 任務模板 + ADR Alternatives/Consequences
- **build**：紅綠分離 + TDD 測試品質判準餵 test-author + 三種 slicing + Save Point
- **verify**：多維 reviewer = 借 code-reviewer 五軸 + **整支 security-auditor** + test-engineer 覆蓋模板 + 條件性效能 reviewer；編排照 `docs/agents.md`；通用螺絲 Metric-Honesty
- **iterate**：`debugging-and-error-recovery` triage + doubt-driven 3 圈上限 + Pre-Launch checklist 收尾
- **共用**：skill-anatomy 骨架、context-engineering 量化、Change Summaries 交接模板
