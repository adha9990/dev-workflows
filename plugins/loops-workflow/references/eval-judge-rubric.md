---
dimension: explanation-quality
scale_min: 1
scale_max: 5
threshold: 4
schema: 1
---

# eval-judge rubric：解釋/溝通品質（無可執行 ground truth 維度）

> **oracle-first, judge-last**：能用可執行 oracle（測試轉綠 / exit 0 / 檔案存在）判的維度**一律不用 judge**（走 E1 oracle / E3 trajectory）。本 rubric 只評**沒有 ground truth** 的維度——交付物的**解釋/溝通品質**（PR body、explain 理解包、commit 訊息、設計說明對「人類讀者能不能看懂、能不能據以驗證/維護」的品質）。
>
> **這是 judge 的鎖死評分卡（G-Eval 式）**：evaluation steps 是**固定的**，judge 必須逐步照走、不得自創或略過步驟（防分數漂移）。機讀欄位（frontmatter）由 `scripts/eval-judge.mjs` 驗證；本 rubric 的 frontmatter 變更視同契約變更，需走 verify。

## 評什麼（dimension：explanation-quality）
被評對象是「**給人類讀的解釋性產物**」本身的品質，**不是 code 對不對**（那是 oracle 的事）。聚焦：
- **可理解性**：不熟該領域的工程師讀完能不能懂「改了什麼、為什麼、影響誰」。
- **可驗證性**：有沒有給出讀者能據以**自行驗證**的證據/指令（不是「我測過了」這種自報）。
- **完整無誤導**：有沒有漏關鍵脈絡、有沒有與 artifact 實際行為不符的描述。
- **精煉**：在不犧牲上述前提下是否精煉——**長度不加分**（明確抑制 verbosity bias）。

## 分數刻度（1–5；threshold=4 才算 pass）
- **5**：清楚、完整、可獨立驗證；不熟領域者讀完即懂且能自行驗。
- **4**：清楚且大致完整，至多一處小缺漏不影響理解/驗證（**pass 下限**）。
- **3**：可懂但有明顯缺漏（缺驗證證據 / 缺關鍵脈絡 / 偏冗長）。
- **2**：難懂或有誤導，讀者需回頭問才能動工。
- **1**：空泛 / 與 artifact 不符 / 無法據以理解或驗證。

## Evaluation steps（鎖死，逐步照走）
1. 讀 artifact + 契約（issue / `02-plan.md` 契約 / diff / 被評的解釋性產物），標出它**聲稱要溝通什麼**（受眾、要傳達的改動與理由）。
2. 逐項檢查解釋是否**可理解**（不熟領域者能否懂改了什麼/為什麼/影響誰）、是否**可驗證**（是否給出讀者能自行跑/查的證據而非自報）、是否**完整無誤導**（對照 artifact 實際行為找漏項與不符）。
3. 評**精煉度**：是否在不犧牲前述前提下精煉；**明確不因長度而加分**（冗長且未提升理解 → 扣分）。
4. 依刻度給 1–5 整數分，寫 `reasoning` 指出**具體依據**（哪段解釋對應 artifact 哪行、漏了什麼、讀者會卡在哪），並自填 `pass`（僅供參考，最終以 threshold 推導為準）。

## 反偏誤紀律（judge 必守，複用 verify）
- **只給 artifact + 契約**，**不告知「作者說已通過 / 已驗證」**（防 sycophancy／被作者主張帶風向）。
- judge 與被評產物**不同上下文/來源**（fresh context，防 self-enhancement 偏好同源輸出）。
- **Metric-Honesty**：judge 分數是 `judge-estimate`（啟發式、非確定性權威），與 oracle 的 `measured` 分軌、**絕不**進回歸 gate 的 passRate 曲線。
- **長度不是品質**：明確抑制 verbosity bias——更長的解釋不因此得高分。

## 輸出格式（給 `eval-judge.mjs` 解析）
judge 必須輸出單一 JSON 物件（容許前後 prose 或 ```json fence）：
```json
{ "dimension": "explanation-quality", "score": 4, "pass": true, "reasoning": "<具體依據>" }
```
`score` 為 frontmatter `scale_min`–`scale_max` 內整數；最終 `pass` 由 `eval-judge.mjs` 以 `score ≥ threshold` 推導（覆蓋自報，自報不一致會標 `passMismatch`）。
