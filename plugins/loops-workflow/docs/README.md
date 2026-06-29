# loops-workflow docs

教學與說明文件（怎麼運作 / 怎麼用）。決策紀錄 / 迭代過程不放這裡（見 `references/docs-policy.md`）。

> **命令介面**：使用者唯一的 pipeline 入口是 **`/loops-workflow:dispatch`**（或別名 `/loops-workflow:loop`）—— 它判類型、分流到對的起點階段。**各階段 skill（goal / define / explore / clarify / plan / build / verify / iterate）標 `user-invocable: false`、不出現在 `/` 選單**，由 dispatch 內部用 Skill tool 驅動。另保留 opt-in / side 命令：`explain`、`agents-md-maintainer`、`scaffold-fullstack`、`resume`、`status`、`install-statusline`。

- [FLOW.md](FLOW.md) — **完整流程圖**：從一句話 / issue 到開 PR，每階段的 skill / agent / 機制 / 策略，含 mermaid 全貌（總流程、build 紅綠分離、verify fan-out）。
- [REFERENCES.md](REFERENCES.md) — **規範目錄**：47 份 `references/` 共用規範依功能分 6 類（寫碼品質標準 / 階段 schema / 驗證機制〔含 8 份 per-axis 審查判準〕/ 對外溝通〔含 `outbound-templates` 統一索引〕/ 編排進階 / 工具模板），各自處理什麼、誰在用。
- [optimization-odw-ecc.md](optimization-odw-ecc.md) — **優化總覽**：吸收 ODW（open-dynamic-workflow）、cobus（loop-engineering）、ECC（affaan-m/ECC）三專案的策略、優化內容（quality-gate 腳本 / 完工 outcome 度量 / reviewer 右尺寸化 / 6 opt-in hook / operation first-move / instinct 學習）與結果。
