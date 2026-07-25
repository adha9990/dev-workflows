# loop：170-policy-component-integration-registries

> feat(registries)：policy/component/integration registries 與 compiler

| 欄位 | 值 |
|---|---|
| **類型** | issue |
| **issue** | [#170](https://github.com/adha9990/dev-workflows/issues/170)（parent: #168；depends on: #169 ✅、**#183 ✅merged**） |
| **operation 性質** | `new-feature` |
| **起點階段** | goal |
| **當前階段** | 完工 |
| **session** | 78271dcb-8ef0-4ef2-8a67-7f9913544e32 |
| **推進模式** | auto |
| **base** | master @ 6a6c26a |
| **worktree** | `.claude/worktrees/170-policy-component-integration-registries` |

## 本 loop 的流程調整（使用者指示）

- **跳過 verify 階段**（沿用 #183 的 E19 決定）。設計審查仍跑，但獨立 verify 不跑。
- SkillOpt（#179）留到 program 最後。

## #183 已交付、本票不必重做的部分

issue 的「雙 harness compiler 增補（2026-07-24）」那整段大部分已由 #183 完成：

| 增補要求 | #183 交付狀態 |
|---|---|
| registry 含 runtime capability / platform projection / scoped override schema | ✅ `references/capability-registry.json`（10 facet ＋ `overrides[]`） |
| canonical 不得寫死平台工具名／vendor model | ✅ compat-lint C3（全庫命中 152 → 0） |
| compiler 產生或驗證兩平台薄 projection | ✅ `gen-reviewers --check`（21 agents ＋ 分層表）、`gen-hooks-codex` ＋ C6 |
| 偵測缺 mapping／手改 generated／語意漂移／平台專屬規則缺 scope-理由-測試 | ✅ C2／C6／C3／C5 |

⇒ **本票的增量**＝policy / component / integration 三個新 registry ＋ 它們的 compiler ＋ affected-source graph。

## Journal（append-only）

- [E1] dispatch：issue# 明確 → 起點 goal。建 loop.md ＋ worktree @ master 6a6c26a。
- [E2] dispatch：核對 #183 交付面，確認本票增量範圍（見上表），避免重做已完成的事。
- [E3] goal：產 `00-goal.md`（S1–S12），現況實測：13 條 Operating Rules／57 references／20 hooks／11 skills／25 agents／10 corpus／1 registry／8 道 gate。
- [E4] plan：§0–§9 ＋ 13 任務，validate 通過。
- [E5] 設計審查（1 輪 opus fresh reviewer）判「要修」，**6 條必修**。最嚴重三條：①`generated drift`（issue 驗收第 2 條第 6 項）**被靜默丟掉且未列 descope**；②`ok = findings.length === 0` 沿用前例會讓**真衝突 exit 0**（最重要那條 AC 的直接假綠路徑）；③實查 `compat-lint.mjs:870` 的 walker **只收 `.md`**，所以我寫的「新 registry 跑 compat-lint 零命中」是恆真空綠。另 reviewer 實查 AGENTS.md 發現 13 條多為**活動型規則、無自然 path glob**，scope 模型可能表達不了。
- [E6] 折回：契約 1 補 `requires`/`forbids`/`conflicts_with`/`projection_marker` ＋ P6（fail-closed 必填）/P7（投影標記＝generated drift）/P8（自帶平台中立檢查）；契約 2 補 `required_checks.integrations` ＋ C5；契約 3 補 I5/I6；契約 4 明訂 `ok` 納入 `decisions` 且摘要須渲染。任務 13→16（新增 T0 資料切片提前證偽、T4b generated drift、T12 端到端波及面煙霧），T1–T10 改為各自 `--filter` ＋ `--min-cases` 地板（原本 10 個任務共用同一條指令，無法證明該任務的測試存在），T11 由「零 finding」改為**可證偽的覆蓋率地板 ＋ 變異斷言**。
- [E6a] 折回過程自己踩到一次假成功：替換 loops-plan 區塊的 regex 沒容忍 CRLF、replace 靜默未生效，而腳本無條件印「已替換」。回讀核實才抓到。已改為「先驗有無命中、replace 後比對、回讀確認任務數」三重檢查。
- [E7] build 完成 16/16。合併態 gate：49 支測試 0 fail、9 道 gate 全 exit 0、波及面查詢對真實路徑回出有意義答案。
- [E8] PR #191 開出（pr-gate 依 verify 跳過指示用 LOOPS_PR_GATE=0 逃生口）、CI 雙平台綠、squash merged。issue #170 CLOSED。
- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 5 ｜ 回環 0 圈（verify 依指示跳過）｜ findings 6→0（設計審查）｜ 交付：PR #191 merged
