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
