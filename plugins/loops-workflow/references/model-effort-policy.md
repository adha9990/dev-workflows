# model / effort 分層政策（cost-aware）

> loops 各 agent 依角色**靜態**選 model + effort（frontmatter）；build / verify 依風險**動態**覆寫 model。落實 `AGENTS.md` 規則 10（便宜的先、貴的後且要 gate）。**改分層＝改本表 + 對應 agent frontmatter 兩欄，兩者需一致。**

## 能力邊界（Claude Code）
- **model**：agent frontmatter 靜態設 + Task 派工時 per-dispatch 覆寫。優先序：env > per-dispatch > frontmatter > session。
- **effort**：agent / skill frontmatter 靜態設。優先序：env > frontmatter > session。**沒有 per-dispatch effort 參數** —— effort 無法依單次任務動態變；純 prompt「think harder」對計費無效。
- frontmatter 蓋過 session → 設了 tier，session 開 xhigh 也不會拖著 subagent 跑。

## Phase 1：靜態分層（agent frontmatter）

各 agent 依角色在 frontmatter 靜態設 model + effort。下表由 `references/capability-registry.json`（`agent_tiers` / `agent_effort` / `model_tier`）機械生成、與各 `agents/*.md` frontmatter 對帳一致（`gen-reviewers.mjs --check` 驗證，不得手改，見表格區塊內註解）：

<!-- BEGIN:generated-tier-table -->
<!-- 本區塊由 `gen-reviewers.mjs` 從 `capability-registry.json` 生成，請勿手改；要改請改 registry 再跑 `--write`。 -->

<!-- adapter-projection -->
| agent | model | effort | tier |
|---|---|---|---|
| `referee` | `opus` | `high` | `referee` |
| `architecture-reviewer-deep` | `opus` | `high` | `referee` |
| `code-quality-reviewer-deep` | `opus` | `high` | `referee` |
| `security-reviewer-deep` | `opus` | `high` | `referee` |
| `finding-validator-deep` | `opus` | `high` | `referee` |
| `accessibility-reviewer` | `sonnet` | `medium` | `broad-review` |
| `architecture-reviewer` | `sonnet` | `medium` | `broad-review` |
| `ci-cd-reviewer` | `sonnet` | `medium` | `broad-review` |
| `code-quality-reviewer` | `sonnet` | `medium` | `broad-review` |
| `docs-devex-reviewer` | `sonnet` | `medium` | `broad-review` |
| `frontend-ui-reviewer` | `sonnet` | `medium` | `broad-review` |
| `migration-reviewer` | `sonnet` | `medium` | `broad-review` |
| `multi-user-concurrency-reviewer` | `sonnet` | `medium` | `broad-review` |
| `observability-reviewer` | `sonnet` | `medium` | `broad-review` |
| `performance-reviewer` | `sonnet` | `medium` | `broad-review` |
| `processing-reliability-reviewer` | `sonnet` | `medium` | `broad-review` |
| `product-contract-reviewer` | `sonnet` | `medium` | `broad-review` |
| `root-cause-reviewer` | `sonnet` | `medium` | `broad-review` |
| `security-reviewer` | `sonnet` | `medium` | `broad-review` |
| `tests-reviewer` | `sonnet` | `medium` | `broad-review` |
| `web-performance-reviewer` | `sonnet` | `medium` | `broad-review` |
| `test-author` | `sonnet` | `medium` | `implementation` |
| `impl-author` | `sonnet` | `medium` | `implementation` |
| `finding-validator` | `sonnet` | `medium` | `fast-readonly` |
| `eval-judge` | `sonnet` | `low` | `fast-readonly` |
<!-- /adapter-projection -->
<!-- END:generated-tier-table -->

> 分層依據：`broad-review`／`implementation` tier effort 為 `medium`，是廣度審查 / 一般實作的預設；`fast-readonly` tier 的純評分窄任務（`eval-judge`）effort 降為 `low`，但守門判斷責任重的 `finding-validator` 仍留 `medium`；`referee` tier（罕見高判斷）effort 為 `high`。各 tier 對應的 model 字面見上表（由 registry 投影）。四個 `-deep` 變體同屬 `referee` tier，frontmatter 靜態即該 tier 的 model/effort，但平常不派、僅 Phase 2 高風險改派時才出。

## Phase 2：動態覆寫 model（派工時，只 model）
- **verify**：步驟 1 判**高風險**時——審查軸 `security` / `architecture` / `code-quality`(correctness) 改派其 **`referee` tier 的 `-deep` 變體**（`security-reviewer-deep` / `architecture-reviewer-deep` / `code-quality-reviewer-deep`；因 effort 無法 per-dispatch，高 effort 只能靠變體）；步驟 3 的 `finding-validator`（驗證者、非審查軸）同樣改派 `finding-validator-deep`（同為 `referee` tier）；其餘軸維持 base（`broad-review` tier）+ per-dispatch 覆寫至 `referee` tier 的 model。瑣碎 / 一般維持 `broad-review` tier 的 model。
- **build**：impl-author 遇 **L / XL 尺寸、跨子系統、或新架構接縫**的任務（見 `task-template.md` 尺寸階梯；XL 照理應在 plan 拆掉、此為兜底）時該次以 `referee` tier 的 model 派出；一般維持 `implementation` tier 的 model。referee agent 本身已由 frontmatter 固定 `referee` tier。
- **effort 不覆寫**（無 per-dispatch）。

## 維護
改 tier：改 `references/capability-registry.json`（`agent_tiers` / `agent_effort`）→ 跑 `node scripts/gen-reviewers.mjs --write` 同步重生 `agents/*.md` frontmatter 與本檔表格區塊。正本是 registry，本檔表格是衍生產物、不再手改。
-deep 變體（security / architecture / code-quality / finding-validator）body 逐字複製 base，base 改審查 / 判定行為時須同步。
