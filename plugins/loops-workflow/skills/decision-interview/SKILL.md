---
name: decision-interview
user-invocable: false
description: Systematically surfaces what nobody wrote down — tacit knowledge, blind spots, and undecided questions — into a four-quadrant Unknowns Register, asking the user one question at a time and only about decisions that change scope, behavior, acceptance, or architecture. Called internally by clarify/define/plan when the work is risky enough to warrant it; never a public entry point.
---

# decision-interview — 把「沒人寫下來的東西」問出來（內部能力）

## Overview

clarify / define 已經一次一問，但那偏向**把已知需求補完整**。真正拖垮 loop 的常常是**沒被問出來的東西**：使用者知道卻沒寫下的隱性知識、以及雙方都沒想到的盲點。本能力負責系統性地把它們挖出來，落成一份**四象限 Unknowns Register**，並在 build 前當一道閘。

> **不新增公開入口**：由 `clarify` / `define` / `plan` 依風險內部調用。小任務不跑完整訪談樹——右尺寸鐵則照舊（見 `AGENTS.md §1`）。

## When to Use

**Use when**（由呼叫端判斷）：
- `clarify`：一句話需求、方向未定。
- `define`：要把 intent 寫成 issue，acceptance 還講不清楚。
- `plan`：拍板前發現有會改動架構 / 資料模型 / 安全面的未決點。

**NOT for**：
- 查得到答案的事實問題（見下方〈先自己查〉）。
- 瑣碎 / 純 refactor / 已完全明確的工作——別加 ceremony。
- 反覆逐項逼問：訪談是**收斂**，信心夠就停。

## Process

### 1. 先自己查，再決定要不要問人

**能從 repo / 工具查得出答案的，一律自己查完再說**——問使用者「這個專案用什麼測試框架」是浪費對方的時間，也讓人對後面真正重要的問題失去耐心。

| 問題型別 | 誰來答 |
|---|---|
| **factual**（現況是什麼：檔案結構、既有慣例、依賴版本、既有行為） | **自己查**（讀 code、跑指令、查 graph）；查完把答案當 `known-known` 記進 register，附證據 |
| **decision**（要往哪走：會改變 scope / behavior / acceptance / architecture 的取捨） | **問使用者** |
| 查不到、也不影響方向 | 記成 `known-unknown`、標 non-blocking，往下做 |

### 2. 一次一題

- **一則訊息只問一個問題**，開一個決策點給 2–4 選項、**標推薦並附一句理由**（內容準則見 `references/shared/delivery/comment-policy.md`；表述形狀與各平台的映射見 `references/shared/delivery/interaction-adapter.md`）。
- 每題先寫下自己的 **HYPOTHESIS + CONFIDENCE(0–100)**，優先問**信心最低 × 影響最大**的那一個。
- 對方回答後**先更新 register 再問下一題**——不要一次拋三個問題再一起消化。

### 3. 挖 tacit knowledge（`unknown-known`）

使用者沒寫下、但**看到就認得出來**的東西，問「你要什麼」問不出來，要**拿具體的東西去撞**：

- **給例子**：兩三個具體情境／版型／流程，問「哪個比較接近你要的」。
- **給反例**：「如果 X 發生，這樣算對還是錯？」——邊界比正例更能逼出隱性規則。
- **給原型**：ASCII 線框 / 一段假輸出，讓對方指著改。

撞出來的每一條都記成 `known-known`（使用者確認過）或 `known-unknown`（還要再確認）。

### 4. 找盲點（`unknown-unknown`）

盲點只能被**發現**，不能被問出來。做過哪幾種盤查要留痕（`blindSpotPass`）：

- **code exploration**：讀真實 code / 資料流，找沒人提過的耦合、既有行為、遷移面。
- **外部研究**：這類問題別人踩過什麼坑。
- **blind-spot pass**：逐項掃 scope／UX／data／security／architecture／acceptance 六面，問「這一面有沒有我們都沒討論到的？」
- **reviewer 視角**：假想 verify 的六軸 reviewer 會先問什麼。

> **系統永遠不宣稱盲點已清零**——那不可知。register 只記「做過哪些盤查」與「殘餘風險」。

### 5. 維護 Unknowns Register

每條 unknown 是 work graph 上的一個節點（欄位與轉移由 `scripts/unknowns-register.mjs` 機械驗證）：

`id` / `kind`（四象限）/ `statement` / `source` / `owner` / `discovered_at` / `affects` / `blocking` / `status` / `resolution` / `evidence`

狀態流：`discovered → open → researching → resolved`；既有事實被推翻走 `invalidated`，並**降回 `known-unknown`**。

- **`known-known` 只能由 researched / decided 轉入**——AI 自己的假設**不得**自行升格成事實。
- **`affects` 命中 scope／UX／data／security／architecture／acceptance 任一 → `blocking` 必為 true**（不得自我豁免；機械檢查會擋）。

### 6. 各階段的責任

| 階段 | 對 register 做什麼 |
|---|---|
| `clarify` | **create**：把模糊需求拆成 known-unknown；撞 tacit knowledge |
| `define` | **update**：把已確認的轉 `known-known` 寫進 issue AC；未決的標 owner 與 blocking |
| `explore` | **resolve / discover**：研究解掉 known-unknown；探索過程發現的盲點記成新節點 |
| `plan` | **gate**：拍板前確認**沒有未解決的 blocking unknown**；有就回去解 |
| `build` | **不得開工**：`gateBuild()` 仍有未解決 blocking unknown 即擋（policy `unknowns-before-build`，tier 2） |
| `verify` | **discover**：reviewer 發現的新盲點回寫 register |
| `iterate` | **resolve / reclassify**：收尾時把殘餘風險列進完工文件 |

## Verification

- [ ] 每題都是**一次一題**，且問的都是 decision 型（factual 已自己查完，答案附證據進 register）。
- [ ] 每條 unknown 欄位齊全、通得過 `validateUnknown`；狀態轉移合法。
- [ ] `affects` 命中六面向的都標了 `blocking: true`，且有 owner。
- [ ] 進 build 前 `gateBuild()` 為綠；沒綠就沒進 build。
- [ ] 至少做過並留痕一種 blind-spot pass；**沒有宣稱「盲點已清零」**。
- [ ] `PROGRESS.md` 看得到四象限摘要、blocking 項、owner 與殘餘風險。

## Anti-patterns

- **把查得到的事實丟給使用者問**——浪費對方時間，也稀釋真正該問的決策。
- **一次拋三題**——對方只會回一題，其餘靜默消失。
- **AI 把自己的假設寫成 `known-known`**——那是把猜測洗成事實，後面整條 loop 都建在它上面。
- **標了 `affects: [security]` 卻寫 `blocking: false`** 好讓自己能進 build。
- **回報「unknown unknowns: 0」**——不可知的東西不能宣稱清零。
- **register 只在 clarify 寫一次就再也沒動**——它是活的，每階段都有責任。
