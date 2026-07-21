# 正確性審查（correctness-review）

> code-quality-reviewer 用：在評風格 / 可讀性**之前**先審正確性。審讀順序＝先追狀態流，再看程式品質。
>
> 分工：同步路徑的狀態流 / 雙寫一致性 / transaction 正確性在這裡審；非同步 queue / 背景 job / 長流程的 retry·cancel·部分失敗歸 `processing-reliability-reviewer`（條件式），兩邊不重述。**in-process 的延後回呼（debounce / timer / 樂觀更新）捕捉了會過期的可變 target 的 stale-capture / 打到錯 target 也在這裡（§六）** —— 這是**恆審**的正確性軸，不必等專案宣告多人（那是 `multi-user-concurrency`）、也不必碰 queue / 背景 job（那是 `processing-reliability`）才審。

## 一、狀態流追蹤 + 不變量三問

沿一條使用者動作把**完整狀態流**追下來（輸入 → 處理 → 各個被改的狀態 → 回應 / 回顯），不要只看單一函式。對每條改動問：

- **成功時**：所有相關狀態是否一致？（同一筆資料在多處表示，是否同步更新；衍生值 / 計數 / 索引是否跟著對）
- **失敗時**：是否留下半成品 / 懸掛引用 / 假 success？（中途錯誤是否讓資料停在不合法的中間態）
- **重試 / 取消 / 重啟後**：最終態是否仍正確？（同一操作走兩次、中途取消、流程中斷重來，收斂到的狀態對不對）

## 二、跨儲存一致性與部分失敗

一個操作同時改**兩個以上會留下副作用的儲存**（DB＋檔案、DB＋快取、DB＋外部 API…）時：

- 其一成功、其一失敗會留下什麼不一致？
- 有沒有補償 / 收斂路徑（重試、reconciliation、pending/dirty 標記、temp-then-rename），失敗路徑會不會收斂回一致態？
- 反向漏洞：「排了後續工作但主狀態沒更新」「主狀態更新了但沒真的排到後續工作」。

## 三、冪等與重複操作

- 同一操作重複觸發（雙擊、retry、重複消費訊息）後最終態是否仍正確？
- 有沒有 dedupe / idempotency key / unique constraint 擋住重複生效？
- **後到的舊回應覆蓋新狀態**（out-of-order）：先發的請求晚回來，是否把較新的結果蓋掉。

## 四、transaction 原子性與並發正確性

> 從**正確性**視角看（鎖粒度 / 交易範圍大小的**效能**視角歸 `performance-review`）。

- transaction 是否包住**所有需要一起成立**的改動？只包一半 = 部分提交風險。
- 並發衝突 / busy / rollback / statement 失敗，是否當成**可預期狀態**處理，而非假設不會發生。
- **read-modify-write** 在並發下會不會用舊值覆蓋新值（讀出 → 改 → 寫回之間別人改過）。
- **check-then-act / TOCTOU**：先查存在 / 先驗條件、再依結果動作（如先 SELECT 判存在再 INSERT），中間別人改了狀態會不會出錯；需要原子保證的要用 upsert / 條件式寫入 / 鎖，而非分兩步。

## 五、跨信任邊界的 runtime validation

- **靜態型別 ≠ 執行期驗證**：跨網路 / 檔案 / DB / 訊息佇列等信任邊界進來的資料，要有 runtime 驗證，型別只是編譯期保證。
- 驗證失敗如何回應（明確錯誤 vs 靜默吞掉 vs 帶著壞資料往下走）。
- 正常使用者也會踩到的邊界：null / 空 / 空字串 / 超長 / 不合法 enum / 損壞輸入 —— 實作是否處理，而非只看測試有沒有測。

## 六、延後回呼的 stale-capture / 打到錯 target（單人時序，恆審）

> 專審**單人、非佇列**的延後執行——in-process 的 debounce / `setTimeout` / `queueMicrotask` / 樂觀更新 / 任何「排程稍後跑」的閉包——**捕捉了一個在它真正觸發前會被外層改掉的可變綁定**（當前選中項 / current-target / 當前 scope / id / `*.current`），於是回呼觸發時打到**已經不是排程當下那個 target**。這條與鄰軸分工明確、彼此不重述：§三「後到舊回應覆蓋」管的是**網路回應亂序**；`ui-interaction-review §四`「取消後殘留」管的是**網路 pending 回應**晚回寫進畫面；`ui-interaction-review §五` 管編輯 **flush 遺失**（沒存到）；`processing-reliability` 管 **queue / 背景 job** 的 retry·冪等——本軸專管「**in-process 延後回呼**觸發時捕捉的 context **過期**、寫 / 送 / 套用到**錯的地方**（target 打錯，不是沒存 / 不是網路亂序）」。

沿每個延後回呼追問：

- **捕捉的是快照還是活綁定？** 回呼體內讀的 selection / id / target / scope，是排程當下 by-value 凍結的**快照**，還是會被外層之後重新賦值 / 切換的**活綁定**（closure over mutable）？活綁定 = 觸發時可能已經是別人。
- **排程與觸發之間 target 會不會變？** 使用者在 debounce 窗內切換了選中項 / 資源 / 分頁 / 路由，或元件重繪讓 ref 指向新東西——flush / 寫入 / 送出會不會落到**切換後的錯 target**（把 A 的暫存值 flush 進 B、把舊 scope 的請求打到新 scope）。
- **切走 / 卸載時有沒有先 flush 對的、再取消或重綁？** 切換 target 時，pending 的 timer / 樂觀更新有沒有先對**正確的舊 target** flush、再取消或以新 target 重排；殘留的舊 timer 回來會不會寫進已不相關的畫面 / 資料。
- **樂觀更新的 target 一致性**：樂觀套用與稍後的伺服器確認 / 回滾，動的是不是**同一筆**；中途切換後回滾會不會改到錯的那筆。

Finding 門檻同 §七：要寫得出「**什麼操作 → 什麼時序（在延後窗內做了什麼切換）→ 打到哪個錯 target**」；只講「這裡有 `setTimeout` 可能有競態」、講不出切換情境的，降 Non-blocking。範例一律用通用詞（scope / id / 選中項 / closure），不綁任何框架 / 專案 API 名。

## 七、Finding 證據門檻

每筆正確性 finding 要能寫出 **觸發動作 → 前置條件 → 程式碼路徑 → 實際會壞成什麼**；寫不出這條鏈、只憑直覺或 PR 描述推斷的，**不報**（降 Non-blocking note 或略過）。不報既有舊問題（除非本次改動讓它惡化或擴散）。
