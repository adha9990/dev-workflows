# 條件式 reviewer（選用領域視角）

> verify 的核心 reviewer（product-contract / architecture / security / performance / code-quality / tests）覆蓋每次都該看的主軸 —— **派哪幾軸由 verify 步驟 1（選軸·依風險定 0~6 核心）決定**（一般 6 軸；高風險 6 軸〔一律滿、不准縮〕；小孤立 3 軸；瑣碎 0；本檔是領域加派層〔conditional〕，與核心下界正交）。下面這些是**領域特定**的額外視角 —— **只在改動觸及該領域時才派**，避免無關維度造成噪音。觸發時與核心 reviewer **同一回合一起派**（並行）。

## 觸發對照

| 改動觸及 | 加派 reviewer | 看什麼 |
|------|------|------|
| 前端 / UI 元件 | `frontend-ui-reviewer` | 元件結構 / state / 樣式 + **交互閉環**（真實寫入 / 假成功 / 快取同步 / 亂序 / 編輯 flush） |
| 使用者介面（任何可見 UI） | `accessibility-reviewer` | 語意 HTML / ARIA / 鍵盤 / 對比 |
| 前端 render / 資源載入 | `web-performance-reviewer` | Core Web Vitals / bundle / 圖片 |
| 後端服務 / 關鍵流程 | `observability-reviewer` | log / metric / trace / 可診斷性 |
| CI/CD 設定 / build script | `ci-cd-reviewer` | pipeline / deploy 安全 / secret / cache |
| schema migration / 介面汰換 | `migration-reviewer` | 可逆 / 向後相容 / backfill |
| queue / 背景 job / 長流程 / 非同步處理 | `processing-reliability-reviewer` | retry / cancel / idempotency / 部分失敗 / 去重排序 |
| **bug fix**（issue 標 bug / 標題含 fix·修·regression） | `root-cause-reviewer` | 症狀 vs 病根 / 因果鏈 / 同類入口 / 回歸測試撤 fix 必紅 |
| **docs / README / 對外契約 / CLI / setup / migration / config 改動，或 PR body 聲稱免改文件** | `docs-devex-reviewer` | 既有文件是否變誤導 / PR body 驗證證據品質 |

> **「先前 comment 是否處理」不另設 reviewer** —— 那由 iterate 蒐齊回饋（`pr-feedback-sources.md`：總評 / inline / reviewThreads）+ 修完強制再 verify 結構性覆蓋。

## 怎麼判斷要不要派

coordinator（主線）看 build 的 Change Summaries + 改動檔案清單：碰到上表的領域就把對應 reviewer 加進這一回合的 fan-out；沒碰到就不派。一次改動可能觸發 0～多個。

## 與核心 reviewer 的分工

- 核心 6 軸（範圍契約 / 架構 / 安全 / 後端效能 / 程式品質〔含 correctness〕/ 測試）：**派哪幾軸由 verify 步驟 1（選軸·依風險定 0~6 核心）決定**（一般 code 全 6 軸；高風險 6 軸〔一律滿〕；小孤立 3 軸〔correctness + 範圍契約 + 測試〕；瑣碎 0）。**右尺寸化只依風險浮動下界、不是給 code 開後門**（拿不準 / 混 code / 碰高風險 path 一律向上升級）。
- 條件式這些：領域特定，**只在觸及時派**（純文件 / 設定動到 docs/config 時，docs-devex 等就是由這層帶入）。
- 兩者輸出同一套格式（P0–P3 + Confidence + Route + 雙視角 + Metric-Honesty），一起進 coordinator 去重 → finding-validator 二輪。

> 註：一般的「程式碼正確性 / 五軸品質 / 測試覆蓋」不另設條件式 reviewer —— 那已是核心 6 個的職責。
