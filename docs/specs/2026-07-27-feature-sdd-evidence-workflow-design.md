# Feature-oriented SDD ＋ evidence portfolio ＋ 風險式選擇性 TDD（設計）

> 2026-07-27 拍板（issue #215）。目標：把 canonical workflow 從「每個 task 固定跑完整 TDD」改成
> **「每個承諾的行為恰有一份足夠且不重複的證據」**，讓實作與驗收成本停止隨 issue 的句子數線性放大，
> 同時**不降低**行為驗收與風險攔截的能力。

## 1. 背景與問題

loops-workflow 雖然宣告 `DDD → SDD → BDD → TDD`，實際執行由「每個 task 固定跑完整 TDD」主導，形成一條
**連續放大鏈**：

```
issue 的每個句子
  → 一條 acceptance criterion
    → 一條 GWT 場景
      → 一個 plan task
        → 一條紅燈測試（每 task 必須有新測試）
          → 再加 contract / 資料限制各自要求的測試
            → 一般 code 固定派滿六個核心 reviewer
              → 每條 finding 再補一條回歸測試
```

每一層單獨看都有道理，加起來就是成本失控。實測案例（PR #318）：新增 6,654 行，其中測試 / benchmark /
測試支援 5,183 行、功能 code 1,459 行（約 3.55:1）；33 個 GWT、14 個 plan task、60 次 subagent 派工。

**問題不是「TDD 沒有價值」**，而是 TDD 被當成所有工作的固定控制面；BDD / SDD / DDD / contract 文件反而
變成額外產生測試的來源。重複證據要到最後一輪裁測才被刪，等於整條 loop 都在為之後要刪的東西付成本。

## 2. 目標與非目標

**目標**：canonical workflow 固定為 **Feature-oriented SDD 主幹 ＋ ATDD evidence portfolio ＋ 風險式
選擇性 TDD**。品質標準從「寫了多少測試、派了多少 reviewer」改成「**每個承諾的行為是否有足夠且不重複的
證據**」。

**非目標**（逐條，防止實作時擴張）：

- 不刪除七階段外殼、issue-first、worktree 隔離、human gate、Metric-Honesty 或安全停。
- 不把所有測試改成人工驗證。
- **不用固定 test:production ratio 當品質標準**（比例只當提醒）。
- 不預設建立新的 architecture layer、port、adapter 或 domain model。
- 不建立 Claude Code 與 Codex 兩份手動維護的 skills / references / policy。

## 3. 已拍板的方法論分工

| 方法 | 唯一責任 | 啟用條件 |
|---|---|---|
| SDD | 主幹：功能、行為、scope、設計、證據與完成條件 | 所有功能工作 |
| BDD | 表達重要且可觀察的行為 | 行為非直觀、跨角色或有重要例外 |
| ATDD | 為每個 behavior 指定 primary evidence | 所有功能工作 |
| TDD | 高風險邏輯的 test-first 實作 | bug / 核心 invariant / 演算法 / 安全 / 並行 / 資料一致性 |
| DDD | 領域語言、invariant、aggregate、bounded context | 複雜業務規則或領域邊界 |
| Contract-First | API、event、schema、跨模組 boundary | 對外或跨模組契約改變 |

FDD 不另加一層 ceremony（issue 已是 feature 單位，plan 改用 vertical behavior slice）。
**使用者不選方法論** —— `explore` 依 predicate 自動套用需要的鏡片。

## 4. 架構：三份新契約 ＋ 兩支新機械閘

```
goal    收斂 behavior_id（1–5 個，非逐句）
  ↓
explore 產三張表：reuse map / impact surface / risk map
        └─ loops-risk-map JSON：domain_complexity / external_or_cross_module_contract
                                + 每個 behavior 的 risk / risk_triggers
  ↓
plan    vertical behavior slice + evidence portfolio + change budget
        └─ loops-plan JSON：behaviors / slices / evidence_portfolio
        └─ validate-plan.mjs 機械擋：缺主證據 / 重複證據 / 缺理由 / 缺 budget
  ↓
build   依 primary_evidence 選路徑（TDD / contract-first / 跑既有證據 / static·smoke / manual）
        └─ test-author 可回 NO_NEW_TEST_REQUIRED
  ↓
verify  ⓪ 確定性閘（quality-gate + validate-plan + diff-footprint）
        ① 風險式選軸（固定 product-contract + code-quality）
        ②③ 並行審 + 對 P0/P1 與低信心高影響 P2 二輪確認
        ④ 逐 behavior 核主證據（Evidence Portfolio acceptance）
        └─ diff-footprint.mjs 吐 loops-footprint marker
  ↓
iterate actionable 收緊為五類缺陷；GUARD 條件式；targeted 再驗
  ↓
pr-gate 閘⑧ 讀 footprint marker：未說明的 drift 不得收圈
```

### 4.1 新 reference（單一正本）

| 檔案 | 管什麼 |
|---|---|
| `plugins/loops-workflow/references/stages/risk-map.md` | 方法論鏡片與驗收強度的**機械觸發表**：兩個 loop 級 predicate、六個 behavior 級 `risk_triggers`、reviewer 選擇表、三條 fail-safe |
| `plugins/loops-workflow/references/stages/evidence-portfolio.md` | 證據型別階梯、四條硬規則（一行為一主證據 / `new_test_reason` / `distinct_risk` / change budget）、誰消費 |

### 4.2 新機械閘

| 機制 | 落點 | 擋什麼 |
|---|---|---|
| `scripts/validate-plan.mjs`（改寫） | plan → build | behavior 沒有主證據 / 兩份主證據沒 `distinct_risk` / `new_test=true` 沒理由 / slice 缺 budget / 同一檔跨兩個 slice |
| `scripts/diff-footprint.mjs`（新增） | verify 步驟 0 | 範圍外施工 / 新測試沒理由 / 重複證據沒 `distinct_risk` / 超出 budget 沒理由。**比例只出 warning** |
| `hooks/pr-gate.mjs` 閘⑧（新增，`LOOPS_PR_FOOTPRINT_GATE`） | `gh pr create` / `ready` | 讀 `loops-footprint` marker，只擋 `status=blocked`；`warn` 與 marker 缺席一律放行 |

## 5. 實作時對原稿做的兩處規範化（issue 原文未展開的細節）

1. **change budget 掛在 slice、不掛在 behavior**。issue 的示意 YAML 把 `production_change_budget` 寫在
   evidence portfolio 條目下；但 budget 是要拿去跟 diff 對帳的，而 diff 的單位是**檔案**，檔案的擁有者是
   slice（「每個 planned changed file 屬於一個 vertical slice」也是 issue 明列的規則）。因此正式 schema 把
   兩份 budget 放在 slice 上，portfolio 條目只保留證據欄位。一個 behavior 一個 slice 的常見情形下兩者等價。
2. **`findings=` marker 的口徑跟著風險式驗證調整**。原本是「候選 blocking finding 條數（P0–P2）」；改成
   「**本輪要求二輪確認的條數**」（P0/P1 全部 ＋ 低信心高影響的 P2）。若不調整，「P2 逐條寫明理由後直接
   收下」會讓 `findings>0 && validated=0` 成立、被閘⑦ 誤擋。閘⑦ 的判定邏輯本身**不變**。

## 6. 驗收與回歸

- [x] 同一功能不再因 issue 句子數量線性生成 GWT、task 與 test（goal 收斂 behavior、GWT 右尺寸、
      task-template 移除「Acceptance > 3」訊號）。
- [x] 每個 behavior 都能追到一個 primary evidence（`validate-plan.mjs` 機械核）。
- [x] TDD、DDD、Contract-First 與額外 reviewer 都由機械可讀 predicate 觸發（`risk-map.md`）。
- [x] `test-author` 可合法回傳 `NO_NEW_TEST_REQUIRED`。
- [x] plan validator 能擋缺失或重複 evidence。
- [x] PR gate 能擋未說明的 footprint drift，但不以固定 ratio 阻擋正當測試（閘⑧ 只擋 `blocked`、
      `warn` 放行，並有正反測試釘住）。
- [x] 一般功能不再固定派出完整 reviewer 組（固定兩軸 + 風險加派；高風險硬閘與缺表退路是不可縮的上界）。
- [x] iterate 不再對每個 finding 無條件新增回歸測試（GUARD 條件式，對齊 `test-rubric.md` §7 in-loop 分流）。
- [x] Claude Code 與 Codex 對同一 canonical policy 產生等價決策（policy registry 單一份，
      `codex-plugin-lint` 全綠）。
- [x] `AGENTS.md`、README 與 `docs/` 的流程說明一致，skill 與 projection 無 drift
      （`skill-lint` / `registry-compiler` / `policy-runtime` / `docs-lint` / `compat-lint` 全綠）。
- [x] repo 既有 lint、hook tests、schema tests 全綠。
- [ ] **current vs redesigned fixture 的成本／品質對照：`not measured`。** 需要用同一批題目各跑一次完整
      loop 才量得到（behavior acceptance、escaped defect、production/test LOC、subagent 數、token、
      verify 輪數）。本次交付**沒有**跑這個對照，因此不宣稱任何成本改善數字。

## 7. 殘餘風險

| 風險 | 現況 |
|---|---|
| 成本改善未實測 | 上表最後一項標 `not measured`。機制面（少派 reviewer、少寫測試的出口、確定性閘早退）都已就位，但**實際省多少沒有數字** |
| marker 由 agent 自己寫 | 閘⑧ 與閘⑥⑦ 同一邊界：省略 marker ＝ fail-open。對抗性省略由 skill 正文治理，不由 hook 保證 |
| 風險判定仍是語意判斷 | `risk_triggers` 由 explore 判，判漏就會少走 test-first。對策是三條 fail-safe（拿不準判 true、高風險硬閘不可縮、缺表退回既有風險梯），但**不宣稱零漏判** |
| 既有 loop 的相容性 | 舊 `.loops` 沒有 risk map / evidence portfolio → verify 退回既有風險梯、acceptance 退回逐句 AC；`validate-plan.mjs` 保留 legacy `tasks` 形 |
