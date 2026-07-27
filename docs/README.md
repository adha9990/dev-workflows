<!-- loops-artifact: docs-index@1 -->
# 文件索引

人真正會讀的文件都在這裡。`AGENTS.md` 與 `plugins/**/skills`、`plugins/**/references` 是**給 AI 執行的契約**，不是給人的教學——不必從那裡開始讀。

## 從這裡開始

| 文件 | 什麼時候讀 |
|---|---|
| [`../README.md`](../README.md) | 第一次接觸：這是什麼、怎麼裝、怎麼開始 |
| [WORKFLOW-GUIDE.md](WORKFLOW-GUIDE.md) | 想知道一條 loop 會發生什麼、你要在哪裡把關、完工會拿到什麼 |
| [SETUP-GUIDE.md](SETUP-GUIDE.md) | 要裝／換／停用／更新外部來源，或某個來源壞了 |

## 想更深入

| 文件 | 講什麼 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 五層架構、程式碼圖與工作圖的差別、哪些檔案可以手改 |
| [POLICY-GUIDE.md](POLICY-GUIDE.md) | 規則的四級執行模型、例外怎麼走、新增一條規則會經過什麼檢查 |
| [MEMORY-GUIDE.md](MEMORY-GUIDE.md) | 事件流／索引／快照三層、壞掉時的行為、怎麼接續中斷的工作 |

## 平台

| 文件 | 講什麼 |
|---|---|
| [CODEX-QUICKSTART.md](CODEX-QUICKSTART.md) | 在 Codex 上安裝、信任 hooks、跑第一個 smoke task，以及目前的能力矩陣 |
| [CODEX-SMOKE.md](CODEX-SMOKE.md) | Codex 在真機上的驗證證據紀錄 |

## plugin 內部參考

[`../plugins/loops-workflow/docs/README.md`](../plugins/loops-workflow/docs/README.md) —— 完整流程圖、可設參數總覽、共用規範目錄。那些偏向「維護這個 plugin 的人」會需要的細節。

## 驗收紀錄

[SKILL-USAGE.md](SKILL-USAGE.md) —— **規則寫了有沒有被載入**：對既有 transcript 量到的 skill／reference 實際載入度，含「宣稱會用卻從沒讀進去」的清單。

[VERIFY-DISPATCH.md](VERIFY-DISPATCH.md) —— **verify 的第二輪確認有沒有真的跑**：逐 session 量到派了幾個 reviewer、幾個 validator。實測到的是「一次都沒派」，以及這支工具刻意判不出來的那一格為什麼判不出來。

[ACCEPTANCE.md](ACCEPTANCE.md) —— 全 repo 驗收的實測結果：哪些閘跑過、哪些因為環境缺少來源而**未量測**、以及殘餘風險與負責人。**未量測不等於通過**——這份報告刻意把沒跑的項目逐條列出來。

## 歷史

[specs/](specs/) —— 個別功能的設計規格草稿，**凍結為某個時點的提案紀錄**，不隨後續演進改寫。讀它們是為了理解「當時為什麼那樣決定」，不是為了知道現況。
