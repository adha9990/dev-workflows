# model / effort 分層政策（cost-aware）

> loops 各 agent 依角色**靜態**選 model + effort（frontmatter）；build / verify 依風險**動態**覆寫 model。落實 `AGENTS.md` 規則 10（便宜的先、貴的後且要 gate）。**改分層＝改本表 + 對應 agent frontmatter 兩欄，兩者需一致。**

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
- **verify**：步驟 1 判**高風險**時——`security` / `architecture` 改派其 **`-deep` 變體**（`security-reviewer-deep` / `architecture-reviewer-deep`，frontmatter `opus`·`high`；因 effort 無法 per-dispatch，高 effort 只能靠變體）；`code-quality` 等其餘軸維持 base + `model: opus` per-dispatch 覆寫。瑣碎 / 一般維持 sonnet。
- **build**：impl-author 遇 **L / XL 尺寸、跨子系統、或新架構接縫**的任務（見 `task-template.md` 尺寸階梯；XL 照理應在 plan 拆掉、此為兜底）時該次以 `model: opus` 派出；一般 sonnet。referee 已由 frontmatter opus。
- **effort 不覆寫**（無 per-dispatch）。

## 維護
改 tier：同步改本表與對應 agent 的 `model:`/`effort:` frontmatter。正本（本檔）是分層真相源。
-deep 變體（security/architecture）body 逐字複製 base，base 改審查行為時須同步。
