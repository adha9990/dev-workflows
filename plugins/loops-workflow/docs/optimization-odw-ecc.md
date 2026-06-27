# 優化總覽：吸收 ODW + ECC 兩專案的策略、優化內容與結果

> 本檔記錄 loops-workflow 透過 deep-research 兩個外部專案、把可移植策略落地到 plugin 自身的歷程與成果。
> 方法論：deep-research 外部專案 → 對照盤出可移植策略 → 用 loops-workflow **自己**跑完整迴圈（goal→explore→plan→build→verify→iterate→squash ship）落地。
> 數字一律以實測 / `ls` / git 為準，非憑記憶（這本身就是落地後萃取出的 instinct 之一，見 §3 dogfood）。

---

## 0. 一句話總結

| 專案 | 核心主張 | 我們吸收後做了什麼 | 結果 |
|---|---|---|---|
| **travisliu/open-dynamic-workflow（ODW）** | 該跑的腳本用 deterministic 工具跑（**零 agent token**），把結果壓成結構化摘要，agent 只在有東西要修時、且只拿摘要進場 | quality-gate 腳本 + build 確認點改讀精簡摘要 + 條件式 fixer | 測試輸出 ~96k→~1.6k 字（約 60×），綠燈零 agent call |
| **affaan-m/ECC** | **hook 化的零-token 自動把關 + 跨 loop 自我學習（instinct）** | 6 個 opt-in hook（成本可觀測 / 自動閘 / compact 提醒 / 防作弊）+ operation-type 紅燈起手式 + instinct 記憶 | plugin 從「孤立迴圈」升級成「成本可觀測、自動把關、有跨 loop 記憶」 |

---

## 1. ODW（open-dynamic-workflow）

### 1.1 它是什麼、解了什麼問題
ODW 是 local-first 的 TypeScript workflow runner，把「重複性 agent 工作」從 ad-hoc prompt 變成版控、可重現的腳本（primitives：`workflow / agent / parallel / pipeline / loop / tool / resume`）。原作者的核心痛點：**跑一次完整測試可燒掉 >100k token**（1497 測試案例、已用 dot reporter + no-color），而 loop 過程同一筆大輸出會被反覆灌進 context。

### 1.2 吸收的策略方法
| 代號 | ODW 技術 | 對我們的意義 |
|---|---|---|
| T1 | **`tool()`：不耗 token 跑 deterministic 腳本、回結構化結果不是原始 log** | 測試/lint/build 用腳本跑，只把**結構化 failures**（`{kind,severity,file,line,ruleId/code,message}`，完整欄位見 `references/quality-gate-schema.md`）進 context |
| T2 | **`loop()`：有狀態、可 resume 的迭代** | test-fix 內圈的骨架 |
| T3 | **quality-gate workflow：綠燈零 agent call、紅燈只餵 failures** | conditional agent invocation —— 沒失敗就不喚 agent |
| T4/T5 | resume / deterministic replay；`settled` 失敗不炸整輪 | 韌性技術（部分我們既有 `.filter(Boolean)` 已對應） |

> **務實邊界（重要 caveat）**：Claude Code 的 `Workflow` 沙箱**不能 spawn `pnpm test`**，所以我們的版本不是「消除 agent 看輸出」，而是「**把輸出從 ~100k 壓到 ~2k**」——由一支 repo 端腳本（Bash 呼叫）壓縮，真正進 context 的是小摘要。

### 1.3 優化內容與結果
| issue | 內容 | PR / 狀態 | 結果 |
|---|---|---|---|
| **#2** quality-gate 腳本 | `scripts/loops-quality-gate.mjs`：跑 vitest `--reporter=json` / eslint `-f json` / tsc，正規化成統一 `failures` 清單（dedup + 上限 + tail 截斷），綠燈印一行 | **PR #5（merged）** | **eagle-app-core smoke：95,828→1,596 字（約 60×）**；115 測試綠；純 node 零外部依賴；Windows `spawn EINVAL`→`shell:true` 修掉 |
| **#3** build 接 gate | build 的紅綠確認點改跑 quality-gate 讀**精簡摘要**（不收完整 stdout）；派 fixer 只帶結構化 failures、不附原始 log | **PR #6（merged）** | 直擊最高 ROI 熱點（測試輸出反覆灌 context）；確認點輸出 ~100k→~2k |
| **#4** type=fix self-merge gating | 原規劃自動 commit PR review 修正並 self-merge | **CLOSED（descoped）** | 既有 build/iterate + 人工 merge gate 已覆蓋，折併不另做 |

> ODW 這條的成果已寫進 build SKILL 的〈quality-gate 整合〉段，成為所有「主線跑測試」確認點的標準做法；契約見 `references/quality-gate-schema.md`。

---

## 2. ECC（affaan-m/ECC）

### 2.1 它是什麼、我們怎麼篩
ECC 是「agent harness performance optimization system」（271 skill、67 agent、跨 7 harness、hook 重度、instinct 學習）。**物種與我們不同**（廣度 / autonomous / hook 重的巨型系統 vs 我們聚焦 / 互動式 / 單 issue），所以原則是**借技術、不照搬哲學**；271 個 skill 多為領域技能（django/healthcare/homelab…），與我們無關。研究用 6 個並行 agent 深讀後，過濾出真正可移植的核心。

### 2.2 吸收的策略方法
- **hook 化的零-token 自動把關**（ECC 的 hook 100% 純腳本、不呼叫 LLM）——這正是 ODW「腳本先跑、只把失敗丟 agent」的**成熟一般化**。
- **成本可觀測**：讀 session transcript 的 usage 算實測 token / USD（ECC 的 cost-tracker）。
- **operation-type first-move**：不同任務性質（fix/change/refactor）規定不同 build 起手式。
- **instinct 跨 loop 學習**：把過往執行萃取成可復用模式、新 session 注入（我們做簡化版、砍掉 ECC 的 background daemon）。

### 2.3 優化內容與結果（Tier A 三張 + Tier B 一張）
| issue | 內容 | PR / master | 結果 |
|---|---|---|---|
| **#15** 成本可觀測閉環（A1） | `cost-tracker`(Stop hook 讀 transcript 算實測 token/USD→`.loops/.metrics/costs.jsonl`)＋`suggest-compact`(PreToolUse 跨門檻提醒壓縮)；outcome 度量接 measured 分支 | **PR #19** `f6d66eb` | 規則 10 成本意識從「只有意識」→**可觀測**；108 測試；opt-in 預設關 |
| **#17** 自動把關（A3） | `stop-gate`(改檔回合自動跑既有 quality-gate、只紅燈注入)＋`edit-accumulator`(只在改檔回合跑、控成本)＋`config-protection`(硬擋 agent 弱化 linter 設定作弊) | **PR #20** `a549e3e` | 零-agent-token 自動把關；88 測試；security review 抓出「自動執行 gate.config 命令＝間接 RCE」→ 加信任警示 |
| **#16** Operation first-move（A2） | dispatch/define 判 operation 性質→build 的 test-author 依 fix/change/refactor/feature 分岔紅燈起手式（修 bug 先寫重現測試…）；三層兜底閉環 | **PR #21** `b469418` | 直接提升「修對/改對」成果正確性；純流程；verify 抓出一個真 P1（主路徑功能曾靜默失效）並修成通用閉環 |
| **#18** instinct 記憶（B1） | `/distill`(Claude 驅動掃歷史 loop ★outcome→提煉方法論 instinct YAML)＋session-start opt-in 注入；簡化版無 daemon | **PR #22** `627f11a` | plugin 從「孤立迴圈」→**有跨 loop 記憶**；73 測試；security 抓出「instinct summary 進 context＝間接 prompt injection」→ 加信任警示 + 截長 + 框定 |

---

## 3. 合併後的 plugin 現況（兩專案優化的疊加結果）

- **6 個 hook / 4 事件**（除 SessionStart 的「浮 active 迴圈」恆跑外，其餘皆 opt-in 預設關；皆永不擋路）：
  - **SessionStart**：浮 active 迴圈 ＋ `LOOPS_INSTINCT_INJECT` instinct 注入（ECC #18）
  - **Stop**：`LOOPS_COST_TRACKER` 成本記帳 ＋ `LOOPS_STOP_GATE` 自動 quality-gate（ECC #15/#17）
  - **PostToolUse**：`edit-accumulator` 改檔累積（ECC #17）
  - **PreToolUse**：`LOOPS_COMPACT_HINT` compact 提醒 ＋ `LOOPS_CONFIG_PROTECTION` 防作弊閘（ECC #15/#17）
- **quality-gate 腳本**（ODW #2/#3）：測試輸出壓縮 ~60×、build 確認點讀精簡摘要、條件式 fixer。
- **operation-first-move 規則**（ECC #16）：build 紅燈起手式依任務性質分岔，見 `references/operation-first-move.md`。
- **跨 loop instinct 學習**（ECC #18）：`/distill` + SessionStart 注入，見 `references/instinct-schema.md`。
- **13 skills、42 references**；文件全同步（FLOW / REFERENCES / README / journaling）且經各 PR 的 docs-devex reviewer 查核一致。
- 各 opt-in flag 的「怎麼開 / 行為 / footprint / SECURITY」目錄見 `references/journaling.md`。
- 全部 squash 合併進 plugin master，每 PR master 一筆 commit。

### dogfood 實證（meta 閉環）
用 #18 剛建的 `/distill` 對 #2–#18 這整批迴圈自己萃取出 5 條方法論 instinct，並用 #18 的 session-start 注入**實跑驗證**成功：

- `[90%]` 主線複跑勝過 subagent 自報 / LSP diagnostics
- `[85%]` plugin hook 一律 opt-in 預設關 + 永不擋路
- `[85%]` docs-only verify 派 2-3 軸、含 code 派核心 6 軸不縮
- `[80%]` 檔案數 / 度量以 `ls` / 實跑為準、不信算術
- `[80%]` 自動執行 repo 內容 / 注入 context → 威脅建模 + 信任警示

---

## 4. 兩專案的關係與互補

- **ODW 給「種子」**：腳本先跑、只把結構化 failures 丟 agent（聚焦 build 階段的測試輸出）。
- **ECC 給「一般化」**：把同一個「零-token 自動把關」概念升級成 hook 化、貫穿生命週期（Stop / PreToolUse / PostToolUse），再往上加成本可觀測與跨 loop 學習。
- 一句話：**ODW 解決「跑測試很燒 token」這個點，ECC 把它擴張成「整條 harness 的自動化 + 自我度量 + 自我學習」這個面。**

---

## 5. 誠實邊界 / 已知取捨

- ODW 的「零 token 跑測試」在 Claude Code 沙箱下只能是「壓縮輸出（~100k→~2k）」，非「消除」。
- ECC 多數內容（271 skill）與我們無關；我們只取方法論層級的可移植技術，沒照搬它的 autonomous / daemon 哲學。
- 所有 hook、instinct 注入皆 **opt-in 預設關**：要真正享受成效需自行設 `LOOPS_*` flag，且自動執行 / 注入類功能**只在信任 repo 開**（已於文件三處警示）。
- instinct 的 `confidence` 是啟發式人工判斷、非統計；token / USD 是依 API usage 的估算、非帳單權威。
- 未做（follow-up）：ODW 的 verify 共用 diff / 跨 round 紀律 / Workflow 化；ECC 的 background observer / size-classifier / confidence 衰退 / export-import。

---

## 附：相關文件
- build 的 quality-gate 整合 → `skills/build/SKILL.md`、`references/quality-gate-schema.md`
- operation 紅燈起手式 → `references/operation-first-move.md`
- instinct 格式與隱私/SECURITY → `references/instinct-schema.md`
- opt-in hook 目錄（flag 怎麼開 / footprint / SECURITY）→ `references/journaling.md`
- 全貌數字總結 → `docs/FLOW.md`
