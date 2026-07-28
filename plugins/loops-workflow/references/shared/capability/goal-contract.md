# Goal Contract — 跨階段的工作契約（capability，不是 phase）

> **為什麼不是階段**：目標不是「做過一次就結束」的工作，而是**每個入口都要維持**的契約。有 issue 的從 issue 解析、沒 issue 的由 `define` 建立、收到 PR comment 的要跟原契約對帳。把它畫成流程圖上的一個方框，會讓「從 plan 起跑」「只驗一份 PR」這些入口變成沒有目標可依據——或是被迫倒退回去重跑一次訪談。
>
> 值域與欄位的唯一真相源是 `references/workflow-vocabulary.json` 的 `goal_contract` 區段。本檔講的是**怎麼用**。

## 三種動作（telemetry 記的就是這三個 activity）

| activity | 什麼時候 | 做什麼 |
|---|---|---|
| `create-goal` | 新需求、還沒有 issue | `define` 在建 issue 的同時把契約寫出來（issue body 與契約講的是同一件事，不是兩份） |
| `resolve-goal` | 已有 issue／已有 handoff | 從 issue body、既有 `goal-contract.md`、或 handoff 的 `goal_revision` 載入；缺欄位就地補齊，**不重跑一次完整訪談** |
| `reconcile-goal` | PR comment、reviewer 回饋、中途冒出的新需求 | 把新輸入與現行契約對帳，判斷它是「契約內的修正」還是「契約要改」 |

**phase 報表裡不會有 `goal`**——它是 capability。成本記在上面三個 activity 上。

## reconcile：reviewer 講的話不會自動變成產品目標

這是最容易出錯的一步。收到回饋時逐條分類：

| 回饋的性質 | 處理 | 契約要不要動 |
|---|---|---|
| 指出實作沒達到契約已承諾的行為 | 當成 finding 修掉 | 不動（revision 不變） |
| 指出契約寫得不清楚，但意思沒變 | 就地把敘述寫清楚 | 不動（措辭修正不是改版） |
| 要求做契約明列 out of scope 的事 | **開一個決策點問使用者**：納入本票、或另開 issue | 使用者說納入才 revision +1 |
| 要求改變已承諾的行為 | 同上，一律使用者拍板 | 拍板納入才 revision +1 |

**不得**因為「reviewer 是資深的／講得有道理」就自己把它升格成新目標。理由很實際：契約一旦被回饋推著走，驗收基準就會跟著漂，最後沒有人說得出「這張票到底做完了沒」。

## revision 的規矩

- 從 1 起算，**只有目標真的改變才 +1**（措辭、補充說明、修正錯字都不算）。
- 每次 +1 要記得下三件事：改了什麼、誰拍板、為什麼。
- handoff 記錄自己對應的 `goal_revision`；resume 時 freshness 的 `goal-revision` 那一項比對的就是它。**對不上代表交接之後目標改過**，那份 handoff 之後的規劃要重來，但**已完成的 define／build 不必整條重跑**——回到最早受影響的階段就好（見 `handoff.md`）。

## 落點與格式

持久化在 `.loops/<slug>/goal-contract.md`（**loop 根，不在 `stages/` 底下**——它不屬於任何一個階段）。
受 artifact contract 納管（`goal-contract@1`），第一行帶 marker。骨架如下，區塊名不要改：

```markdown
<!-- loops-artifact: goal-contract@1 -->
# 工作契約 — <slug>

| 欄 | 內容 |
|---|---|
| Outcome | 做完後世界有什麼不同（一句） |
| User | 誰受益、在什麼情境 |
| Why now | 為什麼現在做 |
| Source | 這份契約解析自哪裡（issue URL／handoff id／使用者拍板） |
| Revision | 1 |

## 行為

| behavior_id | 一句可觀察的行為 | 對到哪幾條需求 |
|---|---|---|

## 驗收與停止條件

- 什麼成立就算做完（pass/fail 可驗證，不是「做得好」這種驗不了的話）

## 限制與不做什麼

- Constraint：不可違反的限制（含專案 `AGENTS.md`／`CLAUDE.md` 宣告、這次會觸及的跨切面約定）
- Out of scope：明確不做什麼

## revision 紀錄

| revision | 改了什麼 | 誰拍板 | 為什麼 |
|---|---|---|---|
```

## behavior 怎麼收斂（沿用既有規則，不重寫一份）

逐句掃過整張 issue 抽 requirement，再**合併成少量 `behavior_id`**（一般 1–5 個）：behavior 是**使用者眼中不同的一件事**，不是句子數、不是欄位數。編號一經指定就不重編——`plan` 給每個 behavior 指定一份主證據、`verify` 逐個回核，靠的都是這串編號。詳見 `references/stages/evidence-portfolio.md`。

## Red Flags

- 從 plan／build／verify 起跑，卻說不出目前有效的 Goal Contract 是哪一份、revision 幾。
- 把 reviewer comment 直接寫進契約，沒經過使用者拍板，revision 也沒動。
- behavior 清單照著 issue 的句子數線性長出來（沒收斂，後面每一層都會照句子數放大）。
- 契約與 issue body 講的不是同一件事（兩份真相源，之後一定分岔）。
- 為了「補完整」把 `resolve-goal` 做成重跑一次完整訪談——已經寫在 issue 裡的不要再問一次。
