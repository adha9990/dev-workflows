# loops-workflow docs

教學與說明文件（怎麼運作 / 怎麼用）。決策紀錄 / 迭代過程不放這裡（見 `references/docs-policy.md`）。

> **命令介面**：使用者唯一的 slash 入口是 **`/loops-workflow:dispatch`** —— 判類型、分流到對的起點階段；輸入既有 loop 的 slug 則自動 resume。**其餘 skill（階段與側用）全標 `user-invocable: false`、不出現在 `/` 選單**，由 dispatch／各階段內部驅動（explain＝完工自動產、agents-md-maintainer＝iterate 條件式自動跑、scaffold-fullstack＝dispatch 路由），或自然語言請求。查進度直接讀 `.loops/<slug>/PROGRESS.md`。

- [FLOW.md](FLOW.md) — **完整流程圖**：從一句話 / issue 到開 PR，每階段的 skill / agent / 機制 / 策略，含 mermaid 全貌（總流程、build 紅綠分離、verify fan-out）。
- [REFERENCES.md](REFERENCES.md) — **規範目錄**：`references/` 共用規範依功能分 6 類（寫碼品質標準 / 階段 schema / 驗證機制〔含 per-axis 審查判準〕/ 對外溝通〔含 `outbound-templates` 統一索引〕/ 編排進階 / 工具模板），各自處理什麼、誰在用（全量與計數以該檔為準）。
- [optimization-odw-ecc.md](optimization-odw-ecc.md) — **優化總覽**：吸收 ODW（open-dynamic-workflow）、cobus（loop-engineering）、ECC（affaan-m/ECC）三專案的策略、優化內容（quality-gate 腳本 / 完工 outcome 度量 / reviewer 右尺寸化 / 6 opt-in hook / operation first-move / instinct 學習）與結果。

> **內容結構健康度自檢**：`node plugins/loops-workflow/scripts/skill-lint.mjs [--root <repo>] [--json]` —— 五類檢查（description footprint／agents 重複與 base⇄deep 同步／references 斷鏈孤兒／寫死計數漂移／死指令引用），只報告不改檔；全綠一行 `✓`、紅燈逐條結構化。改動 skills／agents／docs 後跑一次。repo 新增合法內容被誤報時，同步腳本內的 actualCounts／allowlist 具名常數（維護提示見 `--json` 的 `summary.hint`）。
