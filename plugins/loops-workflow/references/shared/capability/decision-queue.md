# Decision Queue — 一次一個決策的可重算佇列（capability，不是 phase）

> `define` 與 `plan` 共用同一套訪談機制。它取代了原本獨立的 `clarify` 階段：**在還沒理解現有實作之前訪談，會把問題越問越偏**——所以提問前先探索（見 `explore.md`），提問時一次只問一個，每答一題就重算剩下要問什麼。
>
> 提問動作在 telemetry 記成 `clarify` activity。**phase 報表裡不會有 `clarify`**。

## 迴圈（五步，每輪都重跑）

1. **取用現有 evidence** —— 先看 Explore capability 已經查到的事實、已決的 decisions、Goal Contract 現況。
2. **找出仍 blocking 的最高優先 decision** —— 只有「會改變 scope／行為／驗收／架構」的才算 blocking；其餘寫成假設帶過。
3. **一次只問一個 `decision_id`** —— 開一個決策點，2–4 個選項、有把握就標推薦並一句話講為什麼。
4. **寫入答案與 provenance** —— 誰決定的、依據什麼、什麼時候。答案進 decision graph，不是只留在對話裡。
5. **重新計算剩餘問題** —— 被這個答案**消除**的問題不得照舊再問；**性質改變**的要改寫再問。

## 兩條硬規則

- **一個 user turn 只能有一個 active blocking `decision_id`**。一次多問會讓人跳答、漏答，而且下一題本來就該由上一題的答案收斂——一起問等於放棄收斂。
- **`plan → build` 的核准是獨立的最後一題**，不得和套件選型、scope 取捨、架構選擇綁在同一個問題裡。把「要不要開工」跟「用哪個方案」綁在一起問，等於讓人在還沒看清方案的情況下同時批准施工。

## 什麼該問、什麼不該問

| 該問（blocking） | 不該問 |
|---|---|
| 這個行為要不要納入本票 | 查 code／docs 就有答案的事 |
| 兩個方案的取捨（會影響長期正確性） | 你已經有把握、只是想確認的細節 |
| 內容型交付的載體（發到哪、什麼形式） | 儀式性問題（「這樣可以嗎？」） |
| 驗收標準講不清楚的那一條 | 已經寫在 issue 裡的東西 |
| 契約要不要改版（reconcile-goal 的結果） | routine 轉場（「要不要進下一階段」——不問，直接往下） |

**風險夠高就走完整訪談**：需求牽涉 scope／UX／data／security／architecture／acceptance 任一面向且講不清楚時，改用 `skills/decision-interview` 把 tacit knowledge 與盲點挖成四象限 Unknowns Register，未解決的 blocking 項擋住 build（憲章規則 18）。小任務不跑完整訪談樹。

## should-want 偵測

對方用「應該／好的工程會／照理說」這種表演式語氣作答時，追問**一次**真意圖（見 `references/stages/goal-restate-schema.md`）。表演式答案會讓後面整條做錯方向，而它看起來跟真答案一模一樣。

## Red Flags

- 一則訊息塞了好幾個問題。
- 提問前沒有 exploration receipt（違反 Explore-before-question）。
- 前一題的答案已經讓某題失去意義，還是照原樣問出去。
- 把「要不要開工」跟方案選擇綁成同一題。
- 該由使用者拍板的產品決策，自己在腦中轉成假設就往下做。
- 用純文字要使用者打字回覆「yes／要不要繼續」——要嘛開一個決策點，要嘛直接往下。
