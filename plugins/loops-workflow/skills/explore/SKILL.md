---
name: explore
description: Surveys the internal codebase for reusable approaches, and searches external sources only when internal evidence plus the requirement leave the approach uncertain, then lays the findings out with a recommendation. Use when starting the explore stage of a loops-workflow run, or when you need to research how to build something before planning it.
---

# explore — 探索（內外一條龍）

## Overview

`explore` 的研究流程：**先摸架構 → 掃內部找可重用 → 判斷夠不夠 → 不夠才搜外部 → 攤開給推薦**，讓使用者在 `explore → plan` gate 選走哪條路。

**外部搜索是條件式的**：內部 + 需求（issue / 完工定義）已經把「怎麼做」釘死，就**不搜外部**（省資源）；只有**不確定 / 內部證據不足**才搜，且分層 —— 便宜 `WebSearch` 打前哨，需要實作細節才升級 deep-research（經同意）。

## When to Use

**Use when**：dispatch 判為「設計 / 研究」、或 goal 完工定義已定、要研究「怎麼做」才能 plan。

**NOT for**：
- 已經知道用什麼方法、只差拆任務 —— 直接 plan。
- 一上來就 deep-research —— 先用便宜搜索打前哨，貴的要 gate。

## Process（依序）

### 0. 先摸架構（文檔優先）

動手探索前先建立架構認知：**文檔優先** —— 讀 `CLAUDE.md` / `AGENTS.md`（最高優先）、`README` / `docs/` / ADR；文檔已說明架構就以文檔為準，只在文檔有缺口才爬 code。輸出 2–4 行 project context 寫進 `01-explore.md` 開頭。詳見 `references/onboarding.md`。

### 1. 先掃內部（重用優先）

派內建 `Explore` agent（Haiku、read-only，天生適合摸 codebase）找：既有可重用的實作 / 模式 / 類似功能。**出入口稍異不等於要另造** —— 預設擴充或參數化既有方法。回精煉 digest 給主線（不是整檔貼回）。

### 2. 夠了沒？—— 內部 + 需求是否已足夠定案

掃完內部先判斷：**內部可重用機制 + 需求（issue / 完工定義）有沒有已經把「怎麼做」釘死？**
- **夠了**（行為明確、找到可重用做法、無開放問題）→ **跳過外部搜索**，直接到第 5 步寫內部結論 + 推薦。**不要為了「比較保險」去搜外部 —— 那是浪費資源。**
- **不夠 / 有不確定**（內部沒可重用做法 / 做法有多種走向 / 某行為沒共識）→ 才進第 3 步。

### 3. 不夠才搜外部（分層、要 gate）

- 先用便宜的 `WebSearch` / firecrawl 打前哨看業界怎麼做。
- 需要看實作細節、便宜搜索答不了 → **建議升級 deep-research**，**先問使用者同意**再跑（又慢又貴）。

### 4. 框架 API 查證

涉及第三方框架 / 函式庫 API 時，套查證流程 **DETECT → FETCH → IMPLEMENT → CITE**：用 context7 MCP 抓官方文件再下筆；查不到的標 `UNVERIFIED`，不要憑記憶硬寫 API。

> **（可選）Fleet**：同一個研究難題若一條檢索路線不夠，可 opt-in 派多個 agent 各用不同策略查再投票 / 攤開（見 `references/fleet.md`）；多數情況上面的分工式流程已夠，不必編隊。

### 5. 攤開比較 + 推薦

把候選方案寫進 `01-explore.md`：**有搜外部就內外並排**（各自優缺點、適配度、CITE）；內部 + 需求已足夠則列內部結論 + 一句「為什麼不必外部」。給一個推薦 + 理由。**外部來源只有參考價值** —— 寫「參考 + 我的傾向（待你拍板）」，不寫「採用 / 已決定」。停在 `explore → plan` 決策 gate：**用 `AskUserQuestion` 把候選方法做成選項給使用者選**（每個標推薦 + 一句理由），不要用純文字要使用者打字。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「直接 deep-research 最完整」 | deep-research 又慢又貴。先便宜搜索打前哨，多數問題就答了；真要深入才 gate 升級。 |
| 「總之先搜一輪外部比較保險」 | 內部 + 需求已把行為 / 做法釘死時搜外部是浪費資源。外部只在不確定 / 內部不足才搜。 |
| 「外部做法看起來更潮，就用它」 | 先看內部有沒有可重用的；出入口稍異不是另造的理由。外部來源是多一票佐證，不是權威。 |
| 「API 我記得大概長這樣」 | 記憶會錯。框架 API 一律查官方文件查證，查不到標 UNVERIFIED。 |
| 「比較表先省了，直接講結論」 | 沒有攤開比較，使用者沒法在 gate 做有依據的選擇。 |

## Red Flags

- 沒掃內部就直接搜外部 / 直接 deep-research。
- 內部 + 需求已足夠定案，還去搜外部證據（浪費資源）。
- 沒問同意就跑 deep-research。
- 框架 API 沒查證就寫進 `01-explore.md`。
- 把推薦寫成「已決定採用」越過使用者的選擇 gate。

## Verification

- [ ] `01-explore.md` 有方案 + 推薦；**有搜外部才內外並排**，內部 + 需求已足夠則註明為什麼不必外部。
- [ ] 有明確推薦 + 理由，且措辭是「待你拍板」不是「已決定」。
- [ ] 框架 API 來源已 CITE，查不到的標 UNVERIFIED。
- [ ] deep-research（若用）有先經同意。
- [ ] 已停在 `explore → plan` gate。
