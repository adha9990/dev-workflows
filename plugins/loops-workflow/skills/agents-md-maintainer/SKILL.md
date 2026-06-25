---
name: agents-md-maintainer
description: Incrementally creates and maintains agent-facing AGENTS.md docs across a repo — root AGENTS.md, a coverage tracker, and per-module AGENTS.md. Documentation-only, exactly one scope per run, filename strictly AGENTS.md. Standalone side-tool, NOT part of the build loop.
---

# agents-md-maintainer — AGENTS.md 文檔維運（側用，不在迴圈裡）

## Overview

`agents-md-maintainer` 以**小步、高價值**的方式漸進建立 / 維護一個 repo 的 **agent-facing 文檔**（給 AI agent 讀的 repo 說明，不是給人讀的 README）。產出三類檔：根 `AGENTS.md`、覆蓋率追蹤表 `docs/agent-doc-coverage.md`、各模組的 module-level `AGENTS.md`。

它是 **documentation-only 的側用工具**：**不改** runtime 原始碼 / generated 檔 / 行為 / 測試 / build 設定 / migration，不跑破壞性指令；**不在 7 階段迴圈裡**、不被 `dispatch` 路由（與 `explain` 同屬側用）。橫切整個 repo 的文檔治理，與單一 feature 迴圈無關。

> **每次呼叫只完成恰好一個 scope（one scope per invocation）** —— 建根檔、或建追蹤表、或補一個模組，做完就停，不要一輪掃全 repo。

## When to Use

**Use when**：被要求 add / improve / audit / maintain 一個 repo 的 agent-facing 文檔（`AGENTS.md`）。

**NOT for**：
- 跑開發（走 `dispatch` / 各階段）。
- 改行為 / 測試 / build / migration（這隻只動文檔）。
- 寫給人看的產品 README / 教學（那走 `docs-policy` 的功能文檔規範）。

## Process（從 repo root 開始的決策樹）

1. **檢查根 `AGENTS.md` 是否存在。**
2. 若**缺** → 建根 `AGENTS.md`（用下面骨架），**停**（同一輪不做別的）。
3. 若有 → **檢查 `docs/agent-doc-coverage.md` 追蹤表是否存在。**
4. 若**缺** → 建追蹤表，**停**。
5. 兩者都在 → 挑**恰好一個**重要的未覆蓋 / 過期模組 → 掃描它 → 建 / 更新該模組 `AGENTS.md` → 同步更新追蹤表 → **停**。

> 檔名只能是 `AGENTS.md`（禁 `agent.md` / `agents.md` / `AGENTS.MD` 等變體）。

### 最小有用文檔原則

每一行都會被未來的工作載入，所以只寫「能防止錯誤 edit / 錯誤指令 / 錯誤架構假設」的內容；偏好「agent 無法從 code 廉價推得」的資訊。**判斷測試：拿掉這行會不會造成壞 edit？不會就刪。**

### Coverage 優先序

優先高風險系統：背景 job / 非同步流程 / 持久化 / migration / 索引 / 快取 / 同步 / plugin API / 認證授權 / 金流 / 檔案系統邏輯 / AI 整合 / 外部整合 / 對外 API。**不浪費**在靜態資源 / generated / 簡單頁面 / trivial utils / 第三方 vendor。

### Status 五值

追蹤表每列的 `Status`：`missing`（沒有）/ `drafted`（剛掃描建檔、未驗證）/ `verified`（對過 code + tests + call sites）/ `needs-update`（既有但過期 / 不全）/ `skipped`（不該有本地文檔，附理由）。

### 寫模組 `AGENTS.md` 前先 Architecture Scan

掃 entry points / tests / types / call sites / config / 既有 docs / 錯誤處理 / 狀態與持久化 / 非同步與並發 / 對外 API。但只擷取 **constraints / boundaries / commands / pitfalls**，不把掃描內容抄進文件。模組文檔只回答「未來 agent 容易答錯」的問題：這模組擁有 / 不擁有什麼、哪些路徑該先讀它、有哪些 invariants、有哪些具體禁止的捷徑、最相關的 tests / 驗證、已知陷阱。

### 文檔骨架

**根 `AGENTS.md`**（目標 80–150 行）：`Project Overview` / `Repository Structure` / `General Working Rules` / `Common Commands` / `Definition of Done` / `Agent Documentation Maintenance`。

**覆蓋率追蹤表 `docs/agent-doc-coverage.md`** 固定 6 欄：`| Priority | Area | Path | Status | Reason | Notes |`。

**模組 `AGENTS.md`**（目標 60–100 行、soft cap 120）：`Module Purpose` / `When To Read This` / `Invariants` / `Safe Change Guidelines` / `Do Not` / `Testing / Verification` / `Related Documentation`。

### Avoid 清單（別寫這些）

不重複 README、不長篇目錄導覽、不抄套件 manifest / tsconfig / schema 顯而易見的事實、不寫 formatter / linter 已強制的規則、不寫「寫乾淨的 code / 小心一點」這類泛泛建議、不放詳細 API 表（連到 source）。寫**具體 operational 規則**（例：「所有 checkpoint 寫入都要經過某個 store 的 update 入口，否則 recovery 無法保持原子」）勝過「小心狀態」。

## Red Flags

- 一輪掃全 repo / 一次建很多模組（違反 one scope per invocation）。
- 改到 runtime code / 測試 / build / migration（這隻只動文檔）。
- 檔名用了 `AGENTS.md` 以外的變體。
- 把 architecture scan 的內容整段抄進文件（要擷取 constraints，不是傾倒）。
- 寫「be careful / write clean code」這種拿掉也不影響的廢話。

## Verification

- [ ] 這輪只動了**一個 scope**（建根檔 / 建追蹤表 / 一個模組三選一），做完即停。
- [ ] 只改文檔，未動 runtime code / 測試 / build / migration。
- [ ] 檔名是 `AGENTS.md`（無變體）；追蹤表是 6 欄、Status 用五值之一。
- [ ] 寫進去的每一行都通過「拿掉會不會造成壞 edit」測試。
