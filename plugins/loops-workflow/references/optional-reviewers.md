# 條件式 reviewer（選用領域視角）

> verify 的 6 個核心 reviewer（product-contract / architecture / security / performance / code-quality / tests）覆蓋每次都該看的主軸。下面這些是**領域特定**的額外視角 —— **只在改動觸及該領域時才派**，避免無關維度造成噪音。觸發時與核心 reviewer **同一回合一起派**（並行）。

## 觸發對照

| 改動觸及 | 加派 reviewer | 看什麼 |
|------|------|------|
| 前端 / UI 元件 | `frontend-ui-reviewer` | 元件結構 / state / render / 樣式一致 |
| 使用者介面（任何可見 UI） | `accessibility-reviewer` | 語意 HTML / ARIA / 鍵盤 / 對比 |
| 前端 render / 資源載入 | `web-performance-reviewer` | Core Web Vitals / bundle / 圖片 |
| 後端服務 / 關鍵流程 | `observability-reviewer` | log / metric / trace / 可診斷性 |
| CI/CD 設定 / build script | `ci-cd-reviewer` | pipeline / deploy 安全 / secret / cache |
| schema migration / 介面汰換 | `migration-reviewer` | 可逆 / 向後相容 / backfill |

## 怎麼判斷要不要派

coordinator（主線）看 build 的 Change Summaries + 改動檔案清單：碰到上表的領域就把對應 reviewer 加進這一回合的 fan-out；沒碰到就不派。一次改動可能觸發 0～多個。

## 與核心 reviewer 的分工

- 核心 6 個：correctness / 範圍契約 / 架構 / 安全 / 後端效能 / 程式品質 / 測試 —— **每次都派**。
- 條件式這些：領域特定，**只在觸及時派**。
- 兩者輸出同一套格式（P0–P3 + Confidence + Route + 雙視角 + Metric-Honesty），一起進 coordinator 去重 → finding-validator 二輪。

> 註：一般的「程式碼正確性 / 五軸品質 / 測試覆蓋」不另設條件式 reviewer —— 那已是核心 6 個的職責。
