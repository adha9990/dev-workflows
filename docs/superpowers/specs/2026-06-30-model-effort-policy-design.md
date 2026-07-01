# 設計：cost-aware model / effort 分層（Phase 1 靜態 + Phase 2 動態 model）

> 狀態：草案（待使用者過目）｜日期：2026-06-30｜branch：model-effort-policy｜範圍：`plugins/loops-workflow` agents + dispatch/build/verify + 新 reference

## 1. 問題與目標

loops 的 **20 個 agent 都沒指定 `model:` / `effort:`**，build/verify 派 subagent 也不帶 → **全部繼承 session 的 model + effort**。在 Opus + xhigh 跑，16 個 verify reviewer + build 兩個 author 全是 Opus xhigh = 成本失控。

**目標**：依角色 / 風險選 model 與思考深度，讓便宜的先、貴的只花在該花處（落實 `AGENTS.md` 規則 10）。

**已拍板（使用者）**：**Phase 1 保守靜態分層 + Phase 2 風險→model 動態**；**不**納入主迴圈 stage skill 的 effort tier。

## 2. Claude Code 能力邊界（claude-code-guide 依官方文件確認）

| | Model | Effort |
|---|---|---|
| 靜態 per-agent（frontmatter） | ✅ `model:` | ✅ `effort:`（low/medium/high/xhigh/max） |
| 動態 per-dispatch（Task 派工帶參數） | ✅ 可帶 `model` 覆寫 | ❌ **無 per-dispatch effort 參數** |
| 優先序 | env > per-dispatch > frontmatter > session | env > frontmatter > session |

- frontmatter `model`/`effort` **蓋過 session** → 靜態分層即可讓 agent 不跟 session 跑 xhigh。
- effort **無法 per-dispatch 動態**；純 prompt「think harder」對計費無效（官方文件明載）。
- subagent 有獨立 prompt cache → per-agent model/effort 不拖累主對話 cache。

## 3. 設計

### §A Phase 1 — 每個 agent frontmatter 設 `model` + `effort`（保守分層）

| tier | model | effort | agents（`plugins/loops-workflow/agents/`） |
|---|---|---|---|
| 廣度審查 / 一般實作 | `sonnet` | `medium` | product-contract / architecture / security / performance / code-quality / tests（6 核心）+ accessibility / ci-cd / docs-devex / frontend-ui / migration / observability / processing-reliability / root-cause / web-performance（9 條件式）+ test-author + impl-author（共 17） |
| 窄任務 | `sonnet` | `low` | finding-validator、eval-judge（2） |
| 罕見高判斷 | `opus` | `high` | referee（1） |

共 **20 個 agent**，各加 frontmatter 兩欄。理由：verify 是廣度掃描（sonnet·medium 足夠）；validator/eval-judge 是單點驗證（low）；referee 罕見但裁決 test-vs-impl 衝突值得 opus·high。

> **不改各 agent 既有 frontmatter 其他欄**（name/description/tools——含 #73 加的 codebase-memory 唯讀工具），只**新增** `model:` 與 `effort:`。

### §B Phase 2 — dispatch/build/verify 派工時依風險 per-dispatch 覆寫 `model`（真動態）

只作用在 **model**（effort 無法 per-dispatch）：
- **`skills/verify/SKILL.md`**：步驟 1 風險梯判**高風險**時，該回合把**風險相關軸**（尤其 security / architecture / code-quality-correctness）的 reviewer dispatch 以 `model: opus` 派出（覆寫 frontmatter 的 sonnet）；瑣碎 / 一般維持 sonnet。低風險時可反向降（維持 sonnet）。
- **`skills/build/SKILL.md`**：impl-author 遇 **XL / 標記高複雜**任務（見 `task-template` 尺寸）時該次以 `model: opus` 派出；一般 sonnet。referee 已由 frontmatter opus，不需 per-dispatch。
- 以上覆寫規則寫進各 SKILL 的派工步驟，引用 §C 政策正本。

### §C 新增 `references/model-effort-policy.md`（單一正本）
內容：Phase 1 分層表 + Phase 2 覆寫規則 + Claude Code 能力邊界（effort 不能 per-dispatch）+ 規則 10 理由 + 「改分層只改這一處 + 各 agent frontmatter」的維護說明。dispatch/build/verify 引用它。

### §D 文件同步
- `AGENTS.md` 規則 10：加 model/effort 條款（便宜的先 = 依角色靜態分層；貴的動態 = 高風險才 per-dispatch 拉 model；effort 靜態限制）。
- `docs/FLOW.md` §9 自動化 / §10 數字：註記各 agent 的 model/effort tier。
- `docs/REFERENCES.md`：新增 `model-effort-policy` 索引列。

### §E 明確不做（YAGNI）
- 主迴圈 stage skill 的 effort tier（使用者選不納入）。
- agent 變體（reviewer-fast / reviewer-deep）做動態 effort（過度工程；動態只靠 model）。
- 用完整 model id（用 `sonnet`/`opus` 別名即可，隨環境解析）。

## 4. 受影響檔案

**新增**：`references/model-effort-policy.md`
**修改**：20 個 `agents/*.md`（各加 `model:`+`effort:` frontmatter）、`skills/verify/SKILL.md`、`skills/build/SKILL.md`、`AGENTS.md`、`docs/FLOW.md`、`docs/REFERENCES.md`

## 5. 執行性質與驗收
frontmatter 兩欄 + SKILL 派工文字 + 一份 reference，無 runtime code。驗收＝一致性：
1. 20 個 agent 都有 `model`+`effort`、值符合 §A 分層；既有 tools 欄未被動。
2. frontmatter YAML 仍合法。
3. verify/build 的 Phase 2 覆寫規則寫清楚、引用政策正本。
4. `model-effort-policy.md` 與各 agent frontmatter 值一致（正本 = 真相）。
5. 繁中；不破壞既有 agent 行為（只加成本控制、不改審查邏輯）。

## 6. 交付
branch `model-effort-policy`（off master）→ 逐檔改 → 一致性走查 → PR（使用者 review 後 squash merge）。與 doc-fix #74 改不同區段、可各自乾淨合。設計 spec/計畫依前例不進 PR。

## 7. 待實作時再定的小細節（不阻擋拍板）
- Phase 2 「高風險軸」的精確清單（傾向：security / architecture / code-quality；performance 視情況）。
- `effort` 值大小寫 / 合法值以 Claude Code 實際接受為準（low/medium/high/xhigh/max）。
- 是否給 test-author 也保留 medium（傾向是；寫測試需理解契約）。
