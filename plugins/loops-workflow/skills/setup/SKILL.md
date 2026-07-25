---
name: setup
user-invocable: true
description: Installs and reconciles the external sources loops-workflow can use — code graph, evaluation runner, token optimizer, skill optimizer, symbol-aware editing — by asking which ones you want, then applying only the differences. Re-running is safe and does nothing when your choices have not changed. Use when first setting up loops-workflow in a project, or when switching, updating, disabling or health-checking one of those sources.
---

# setup — 安裝與對帳外部來源（第二個、也是最後一個公開入口）

## Overview

loops-workflow 會用到幾個外部來源（跨檔案的 code graph、評測執行器、token 最佳化、skill 最佳化、符號級編輯）。它們**不會被自動安裝**——安裝東西到使用者機器上是使用者的決定。

`/setup` 把這件事做成**對帳**而不是安裝腳本：問你要哪些 → 算出「想要的狀態」與「現在的狀態」的差 → **只對真的有差的那幾個動手**。因此**重跑一次是安全的**：選擇沒變就什麼都不做。

> **公開入口只有兩個**：`dispatch`（開始一條 loop）與 `setup`（管外部來源）。其餘 skill 都是內部能力。

## When to Use

**Use when**：第一次在一個專案裡用 loops-workflow；要換掉／停用某個來源；要更新到最新穩定版；懷疑某個來源壞了想做健康檢查。

**NOT for**：安裝專案自己的依賴（那是專案的事）；一次性試用某個工具（`/setup` 管的是長期啟用的來源）。

## Process

### 1. 問（依 catalog，`references/setup-catalog.json`）

| 類別 | 怎麼問 |
|---|---|
| `required` | **不問**，一律裝——沒有它們，loop 的檢索與語意級規則就沒有承接者 |
| `token-optimizer` | **互斥、擇一或停用**：同一能力的兩個實作不同時啟用（一個推薦、可停用） |
| `recommended` | 預設勾選、可取消 |
| `optional` | 預設不勾 |

每個選項附一句「它幫你做什麼」，推薦項標明推薦並附理由。表述形狀依 `references/shared/delivery/interaction-adapter.md` 映射到當前平台的結構化提問能力；**平台沒有這個能力時降級成一個明確的單題**，不要拆成好幾輪追問。

**資格審查沒過的來源不會出現在選單**——`catalog` 的 `qualification` 欄位就是「還缺什麼」的清單（平台實測、hook 掛載順序、rollback 路徑、真實 benchmark 對照）。**沒有不合格的降級選項，也不提供「自己冒險」的旗標**：不合格就是不出現。要知道被擋掉了什麼，看 `/setup` 輸出的〈未進選單〉一節。

### 2. 算差（reconciliation）

- **desired**：你的選擇（`required` 一律 enabled；互斥組最多一個）。
- **observed**：目前實際裝了什麼、什麼版本。
- **diff plan**：`install` / `update` / `switch-off` / `no-op`，每一步都附**為什麼**。
- **已經裝好的不重裝**：偵測到既有的 code graph 來源 → 走 verify／update，不重來一次。

### 3. 套用（每一步固定三段）

**staged install → health/canary → atomic switch**。任一段失敗就**回上一個可用版本**，該步標成已回滾。

- **latest stable，不 pin 版本**：desired state 不寫死版本號；receipt 記下**實際解析到的版本**（可追溯）。
- **一步失敗不影響其餘步驟**（各來源獨立），但失敗的那一步**絕不留半套**。
- **來源更新只做相容性與 canary 檢查，不自動改 repo 內容**——升級一個工具不該順手改你的專案。

### 3.5 已納管來源的 detect / health / update 契約（#177）

- **code graph**：`detect` ＝列出已索引的專案、比對本 repo 的 canonical root；偵測到就走 **verify → update-if-needed，不重裝**。`health` ＝查索引狀態須為 ready 且節點／邊數非零。
  - **重建時機**：`stage-exit` / `build-checkpoint` / `pre-verify` 這種**穩定的批次邊界**，**不是每次 file edit**——每存一次檔就重建會把時間全花在索引上，而且中途的半成品狀態進了圖也沒有意義（判定在 `scripts/affected-sources.mjs` 的 `shouldReindex`）。
  - 沒有 code／hook 改動時**不重建**（圖不會因此變舊）。
- **評測執行器**：`health` ＝以一個最小可跑的案例確認它產得出結論。**跑不起來時該輪的語意級規則一律標 `degraded`／`not-measured`，絕不寫成 `passed`**。
- **hard invariant 不交給評測器**：tier 1／2 的規則由 hook 與 state 測試判定；評測套件若宣告要判那些規則，`checkNoHardInvariantDelegation` 判紅——把確定的東西換成機率的，是退步不是進步。
- **證據不外洩**：寫進 fixture 與報告的文字一律先過 `redactEvidence()`——絕對路徑收斂成 `<repo>`、憑證遮成 `<redacted:型別>`，**但 `file:line` 保留**（Metric-Honesty 需要的證據不能被遮掉），並逐項列出遮了什麼。

### 3.6 token optimizer 的忠實度契約（#178）

同一能力的兩個實作**互斥、擇一或停用**（`exclusive_group`）。啟用之後，每一次壓縮都要過同一道驗收：

- **受保護證據不得被壓掉**：policy denial／測試失敗／exit code／`file:line`／security finding（含 P0/P1）。判準是「**條數不得減少**」——壓縮本來就會改排版，但證據的條數不該變少。
- **忠實度沒過 → bypass 回原始輸出**。optimizer 丟例外、回非字串、回空字串也一樣。**失敗要被隔離**：壞掉的 optimizer 只該讓人少省一點 token，不該讓人拿到殘缺的證據。
- **每次處理留 receipt**：來源／版本／原始與處理後大小／保留與截斷策略／錯誤／是否 bypass。receipt 不得自相矛盾（宣稱忠實度未過卻沒 bypass ＝ 殘缺的輸出被送出去了）。
- **候選比較：品質先於 token**。task success 或規則遵循度退步 → 一律不接受，不論省多少 token；**品質維度沒量到也不接受**（沒量不等於沒退步）。token／call／duration **只報實測**：沒量標 `not measured`、量到但沒變好標 `not improved`——不拿宣傳數字當實測。
- **資格審查六項全綠才進選單**：平台實測／hook 掛載順序／輸出忠實度／失敗隔離／rollback／真實 benchmark。**`not-measured` 與失敗一樣擋。**

### 4. Receipt

輸出一張表：來源 · 動作 · **實際解析到的版本** · 健康檢查 · 是否回滾 · 說明。這是之後查「當時到底裝了什麼」的唯一依據。

### 5. 自動更新（TTL）

每個來源有自己的 `auto_update_ttl_hours`（`null` ＝不自動更新）。session 開始時，TTL 到期的來源會重新確認最新穩定版；沒到期的**不查、不動**。

## Verification

- [ ] 只有 `dispatch` 與 `setup` 是公開入口。
- [ ] 互斥組的選項清楚標示「擇一或停用」，推薦項有理由。
- [ ] 重跑同樣的選擇 → plan 全 `no-op`，什麼都沒動。
- [ ] 切換互斥組 → 舊的關掉、新的裝上，由同一份 plan 表達。
- [ ] 失敗的步驟都已回滾（沒有半套狀態）。
- [ ] receipt 可追溯來源、解析到的版本、動作、健康檢查與回滾。
- [ ] 選單裡沒有資格審查未過的來源，也沒有任何「實驗性」旗標。

## Anti-patterns

- **自動幫使用者裝東西**——安裝到別人機器上的東西要對方同意。
- **重跑就整包重裝**——那讓 `/setup` 變成不敢碰的操作。
- **pin 一個版本然後再也不更新**——長期會卡在一個沒人測過的組合上。
- **失敗了留著半套**——下次跑的人會遇到一個誰都沒見過的狀態。
- **把不合格的來源加一個實驗性旗標放進選單**——那只是把責任推給使用者。
- **升級工具時順手改 repo 內容**——兩件事要分開，否則沒人知道是誰改的。
