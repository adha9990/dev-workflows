# 專案跨切面約定（project-declared cross-cutting conventions）

> **單一正本。** 目標專案的 `CLAUDE.md` / `AGENTS.md`（root + 就近）宣告的**全域跨切面約定** —— logging、i18n、a11y、錯誤處理、安全、命名、分層… —— 是**每一條 loop 完工定義（DoD）與 verify 檢查清單的一部分，即使該 issue 隻字未提**。issue 的驗收標準是「這次要達成什麼」；專案約定是「這個 repo 一切改動都要遵守的底線」。兩者都要滿足才算做完。
>
> 被 `goal`（折進 DoD）、`plan`（設計時納入）、`verify`（逐條核）、`iterate`（完工交付列出）引用；各階段引此檔、不各自重述。

## 為什麼要這條（真實失敗案例）

一條 issue 只要求「新增一個 command」，其驗收標準沒提 i18n。實作把 label 寫死英文 `'Duplicate'`（其餘 sibling label 都是中文）。plan / verify **都沒抓到**，因為：

- 只**機械地看 lint gate**：專案的 `i18next/no-literal-string` gate 是 `jsx-only`、只掃 JSX 屬性，**不掃 `.ts` 檔裡的 `CommandMetadata.label`** → 那行「合法」通過 lint。
- explore **看到**了 label 是英文，卻合理化成「符合現況慣例、不觸 lint」而放過。

但 `client/AGENTS.md` 明文宣告「**user-facing strings 一律走 i18next**」。**通過機械 gate ≠ 滿足約定的精神**。使用者事後才發現、要求補做 —— 這種「issue 沒寫但專案要求」的東西，應該在 loop 內就一起做掉、並在交付時講清楚。

## 鐵則

1. **讀專案憲章（每條會動 code 的 loop 都做）**：`goal`（或 fix 型的 iterate 起點）**必讀目標專案的 root `CLAUDE.md`/`AGENTS.md` + 改動落點就近的 `AGENTS.md`/`CLAUDE.md`**（例 `client/AGENTS.md`、`src/**/AGENTS.md`），抽出所有**跨切面約定**。常見類別（非窮舉，以專案實際宣告為準）：
   - **i18n / 在地化**：user-facing 字串是否一律走 i18n（t()/catalog）？新字串該進哪個 catalog？
   - **logging / 可觀測**：新功能模組 / 背景工作是否 MUST 附 logging（component child、level 表、關鍵行有測試）？
   - **a11y**：user-facing UI 是否要語意 HTML / ARIA / 鍵盤操作 / 對比？
   - **錯誤處理**：錯誤形狀 / 不吞錯 / 原錯保留？
   - **安全 / 授權**：authn-authz、輸入驗證、參數化、敏感資料不進 log/回應？
   - **分層 / import 方向 / 命名 / 檔案落點**：專案特有的結構規矩。
   - **測試 / 型別 / migration** 等專案特有硬規。

2. **折進 DoD（goal）**：把命中的約定寫進 `stages/00-goal.md` 六欄的 **Constraint**（或另立「專案約定」小節），成為**隱含驗收標準**。issue 沒寫不代表不用做 —— 專案約定是預設底線。**判斷「這次改動觸及哪些約定」**：新 user-facing 字串→i18n；新功能模組/背景工作→logging；新 UI→a11y；動 auth/DB→安全/migration…（沿用 verify 右尺寸的「碰到才算」）。

3. **設計時納入（plan）**：`plan` 的品質維度過一遍時，把命中的約定當**設計輸入**（例：label 要 i18n → 設計要決定 labelKey/t() 接線，而非事後補）。

4. **verify 逐條核（不只看機械 gate）**：verify 的「專案宣告條件」步驟要**枚舉專案憲章的所有跨切面約定**、對每個新 user-facing / 功能面**逐條核是否遵守**——**且不得以「通過了某 lint/gate」當作滿足**（gate 常有掃描範圍死角，如 i18n gate 只掃 JSX、不掃 `.ts` 常數）。命中領域派對應 conditional reviewer（i18n/文案→`frontend-ui`/`docs-devex`；logging→`observability`；a11y→`accessibility`…），並把「違反專案約定」當**可行 finding**（severity 依影響，不因「issue 沒要求」而降級或忽略）。

5. **交付時列出（iterate 完工）**：完工交接物（PR body / 修正回覆）**必須有一段「除 issue 外，依專案約定額外處理 / 確認的跨切面項」**（例：「label 走 i18n（新增 `commands` catalog）」「新服務附 logging 並有測試」「UI 補 ARIA」），或明確「本次無額外約定觸及」。讓工程師清楚知道你除了 issue 還依 repo 底線做了什麼、為什麼。

## Red Flags

- goal 只逐句掃 issue，**沒讀專案 `CLAUDE.md`/`AGENTS.md`** → DoD 漏掉專案約定。
- 看到違反約定的寫法（英文 label、`console.*`、無 ARIA…），因「issue 沒要求」或「通過 lint 了」而放過。
- 把「通過機械 gate」當「滿足約定」——gate 有掃描死角（範圍 / 檔型 / baseline 抑制），要看**約定的精神**。
- 完工交付只講 issue ACs，**沒列**依專案約定額外做的事 → 工程師不知道你動了哪些跨切面面向。

## 與既有規範的關係

- 與 verify 右尺寸化（`verify-triage.md`）、`optional-reviewers.md`〈專案宣告條件〉正交且互補：後者原本只舉「多人/併發→multi-user-concurrency-reviewer」一例，本檔把它**一般化**成「讀憲章、枚舉所有跨切面約定、逐條核」。
- 與 `docs-policy.md`（要不要寫 docs）、`acceptance-review.md`（issue ACs 五態）並列：ACs 管 issue、本檔管 repo 底線。
