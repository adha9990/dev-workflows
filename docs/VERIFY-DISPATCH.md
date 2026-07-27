<!-- loops-artifact: validation-report@1 -->
# verify 派工觀測：第二輪確認到底有沒有跑

> 重現：`node plugins/loops-workflow/scripts/verify-dispatch.mjs`
> 量測時間：2026-07-26。掃描面＝本機所有專案的 session 紀錄。

## 問題

verify 的步驟 3 要求：reviewer 回報的每條候選 blocking finding，都要再派一個 `finding-validator`
做二輪確認（是否真實 / 是否本次引入 / 是否已被既有防護處理 / 修法是否對症）。

這條規則寫在 skill 裡。**它實際上有沒有被執行過？**

## 量到的

| session | reviewer | validator | 其他子代理 | 判定 |
|---|---|---|---|---|
| 產品 repo（一條完整七階段 loop） | **10** | **0** | 15 | `unconfirmed` |
| 本 repo（實作型 session） | 0 | 0 | 80 | `no-review` |

**本機所有 session 紀錄裡，`finding-validator` 的派工次數是 0。** 不是「比例偏低」，是一次都沒有。

那條 loop 的 10 個 reviewer 是完整的——6 個核心軸（product-contract / architecture / security /
performance / code-quality / tests）＋ 4 個依領域加派的條件式（frontend-ui ×2 / accessibility /
web-performance）。步驟 1 的選軸與步驟 2 的 fan-out 都照做了，**只有步驟 3 的第二輪整段不見**。

## 這不是「reviewer 沒讀規範」

追這件事的起點是載入度分析（見 `docs/SKILL-USAGE.md`）指出 `finding-validation.md` 從沒被載入。
第一個假設是「reviewer 拿到參考檔路徑卻沒讀」。**實測完全相反**：那 10 個 reviewer 的 prompt 都帶了
本 plugin 的參考檔絕對路徑，10 個也都真的發出了對應的 `Read`，兩個集合完全一致。

`finding-validation.md` 沒被載入，是因為**要讀它的那個 agent 根本沒被派出來**。失效發生在「沒被派」
這一層，不是「派了沒照做」——這兩者的修法相反：前者要修派工機制或加閘，後者才是重寫措辭。

## 為什麼會漏掉（三個結構性原因）

1. **時序**：步驟 3 的條件寫的是「每個 **blocking** finding」，但 P0–P2 的嚴重度是**步驟 5** 才標的。
   執行步驟 3 的當下，「哪些算 blocking」根本還沒定案——「這幾條不算 blocking」於是成了一個合法、
   無人複查、也不必留痕的自我豁免出口。
2. **判準檔放錯邊**：「什麼情況可以免驗」的規則寫在 `finding-validation.md`，而那份檔是**注入給
   validator 的**，coordinator 拿不到。也就是說，**沒派的時候，決定「可以不派」的規則沒有任何人讀得到**。
3. **沒有機械訊號**：報告末尾的機械 marker 只有 `p0`/`p1`，而它們量的是「判定當下**仍未修**」的條數，
   Ready 時必為 0。所以 marker 永遠回答不了「這一輪到底有幾條 finding、第二輪跑了沒」。
   跳過整個步驟 3 之後，報告看起來和「本來就沒問題」一模一樣。

## 這支工具刻意判不出來的那一格

「派了 reviewer、沒派 validator」**不等於違規**——reviewer 全 clean、零候選 finding 時本來就不必派。
要斷「該派沒派」，需要的是 session 紀錄裡**看不到**的那個數字：這一輪有幾條候選 blocking finding。

所以上表那一格是 `unconfirmed`，不是 `skipped`。這支工具不會把「無法判定」聚合成違規率
（那是在製造假數字）。

補上這一半的方式是讓報告自己說：marker 新增 `findings=`（候選 blocking 條數）與 `validated=`
（其中經二輪確認的條數）。兩邊各有一半，合起來才判得出來：

| 來源 | 有 | 沒有 |
|---|---|---|
| session 紀錄 | 派了誰、派了幾個 | 有幾條候選 finding |
| 報告 marker | 有幾條候選 finding、確認了幾條 | 派了誰 |

`findings>0 && validated=0` 就是「第二輪被跳過」，這是 pr-gate 閘⑦ 唯一擋的事。

## 樣本限制（照實寫）

- **有派過本 plugin 子代理的 session 只有 2 個**，其中**真的跑到 verify fan-out 的只有 1 個**。
  這足以指出「規則沒被執行」，**不足以量化普遍程度**——不要把它讀成任何比率。
- 這支工具只看得到 `subagent_type` 這個欄位。若某輪確認是用別的方式做的（主線自己逐條核、沒派
  子代理），這裡看不到——那會表現成偽陽性的 `unconfirmed`。這也正是它回 `unconfirmed` 而不是
  `skipped` 的另一個理由。
- 判定四態裡，只有 `skipped` 是斷言違規，且它**只能**由報告 marker 得出，不能由派工計數單獨得出。
