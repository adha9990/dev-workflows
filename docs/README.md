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

## 歷史

[specs/](specs/) —— 個別功能的設計規格草稿，**凍結為某個時點的提案紀錄**，不隨後續演進改寫。讀它們是為了理解「當時為什麼那樣決定」，不是為了知道現況。
