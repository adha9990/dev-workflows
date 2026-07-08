# 動手前先摸架構（onboarding，文檔優先）

> explore 掃 codebase 之前的前置步：先建立「專案架構 + 團隊慣例」的認知，讓後續不被局部任務框住。**文檔優先** —— 能從文檔得到的就不派 agent 爬 code。

## 兩步

### 1. 讀文檔建架構認知（優先）

依序讀（有就讀、沒有跳過）：
- `CLAUDE.md` / `AGENTS.md`（**最高優先** —— 團隊硬規範、慣例）。
- `README` / `docs/` 架構文件 / ADR。
- `docs/testing.md` 之類的測試策略、`CONTRIBUTING`。

**文檔已說明架構**（分層、模組劃分、資料流、命名慣例）→ 以文檔為準，**不**派 agent 把整個 repo 程式碼重講一遍。

### 2. 只在文檔有缺口才爬 code

僅當**文檔沒涵蓋目標領域**的分層落點 / 既有 pattern / 關鍵檔案時，才派 `Explore`（帶**聚焦範圍**，不是「把整個 repo 講一遍」，也不是自己 `Glob` top-level 只看資料夾分法）補缺口。

## 產出

2–4 行的 project context summary（架構方向 + 這次要動的東西該插哪 + 相關慣例），寫進 `stages/01-explore.md` 開頭，供後續階段共用。
