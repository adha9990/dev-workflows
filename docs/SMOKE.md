# loops-workflow — Smoke Test 紀錄

> 日期：2026-06-22。在 Claude Code 內實際載入 plugin 並跑過核心行為。結論：**通過**，並由 verify fan-out 咬出一個真 bug、當場修掉。

## 環境

- 載入：`/plugin marketplace add` + `/plugin install loops-workflow@loops-workflow` + `/reload-plugins`。
- reload 輸出確認：plugin 註冊成功。

## Test 1 — 註冊（PASS）

- **7 個 skill** 全部出現在 skill 列表：`loops-workflow:dispatch / goal / explore / plan / build / verify / iterate`。
- **10 個 agent** 全部被自動發現：`test-author / impl-author / referee` + 6 reviewer + `finding-validator`（前綴 `loops-workflow:`）。

## Test 2 — dispatch 路由 + Closed Loop gate（PASS）

觸發 `loops-workflow:dispatch 設計一個範例功能 X`：

| 驗證 | 結果 |
|------|------|
| 分流正確（design + 無 issue → explore 起點） | ✅ |
| 建 `.loops/example-feature-x/loop.md`（類型 / 起點 / 停止條件雛形 / 回環歷史） | ✅ |
| **停在起點 gate、不自動串接 explore** | ✅ |

決策樹、loop.md schema、交棒停止行為都如設計運作。

## Test 3 — verify 六 reviewer 並行 fan-out + validator（PASS）

標的：`C:/tmp/loops-smoke/sample-diff.md`（植入 SQL 注入 / 缺 owner 過濾 / N+1 / 無錯誤處理 / 無測試）。主線**同一回合派出 6 個 reviewer**：

| reviewer | 是否咬到自己那一軸 |
|------|------|
| product-contract | ✅ IDOR / 違反 Constraint「不得回傳他人訂單」P0 + 缺測試 P1 |
| architecture | ✅ route 直打 DB 繞過 service/repository 層、全域 db、DB row 當對外契約洩漏（還主動讀了真 repo 的 `src/repositories/AGENTS.md`） |
| security | ✅ SQL injection P0 + Broken Access Control P0 + N+1 DoS P1，跑了 STRIDE / OWASP |
| performance | ✅ N+1 / `LIKE '%q%'` 全表掃描 / `SELECT *` / 無 LIMIT，效能宣稱標 `not measured` |
| code-quality | ✅ `as string` typing 放水 / 無錯誤處理 / 子查詢未解包 |
| tests-release | ✅ 缺測試 P0 + happy-path-only 會「假綠」反偏見 |

- 各 reviewer **互相讓軸、不重複計分**（Metric-Honesty 生效）。
- 全部輸出 P0–P3 + Confidence + Route + 雙視角（工程 → 使用者）。
- `finding-validator` 對 IDOR P0 跑四問二輪 → **validated**，還主動標出「middleware 只解 authentication 不解 row-level authorization」的 caveat。

## 咬出的真 bug + 修正

**Finding（smoke test 的價值所在）**：6 個 reviewer 有 3 個回報 persona 內的相對路徑 `references/xxx.md` 從 subagent 解不到（subagent CWD 是使用者 repo）。

**根因**：`${CLAUDE_PLUGIN_ROOT}` 在 skill / agent 的 markdown body **不會展開**（Claude Code 已知限制，GitHub #9354）；subagent CWD 又非 plugin 目錄。

**修正（commit `bcf59bd`）**：
- 7 個 reviewer/validator persona 改為「讀 orchestrator 在 prompt 提供的絕對路徑」。
- `verify` / `build` skill 加明文步驟：派 subagent 前從 base directory 推 plugin root、組絕對路徑塞進 prompt。
- `AGENTS.md` 立〈參考檔路徑解析〉全域規則防回歸。

## 結論

核心閉環行為（分流 → gate → fan-out → validator）全部如設計運作；唯一缺口（subagent 參考檔路徑）已根因修正並加防護。plugin 可用。
