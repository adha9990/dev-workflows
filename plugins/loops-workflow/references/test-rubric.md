# 分層測試準則（real-not-mock 紀律）

> build / test-author / tests-reviewer 用：分層測試準則 + real-not-mock 紀律。

核心一句話：**測試要釘住「真的會跑的那條路」，混層或全 mock 都是把假信號偽裝成綠燈。** 一條測試先回答兩個問題 —— 「這次跑的範圍是純邏輯還是要接外部？」「綠了到底證明了什麼？」 —— 答不出來的測試就是雜訊。

## 1. 四層測試模型（混層 = 設計失敗）

明確四層，每層責任不同。**混層就是設計失敗**：unit 不該啟 server、integration 不該全 mock、e2e 不該直接打內部 API。

| 層 | 測什麼 | 紀律 |
|---|---|---|
| **Unit** | 純邏輯、純 in-process，除了 tmp dir 不碰任何 IO | 不啟 server、不開 socket、不下載；永遠 serial 跑；整套要快（秒級） |
| **Integration** | 真實 process / 真實外部依賴（DB、filesystem、雲端），用**合成 fixture**（test-only data）防污染 prod | 慢是正常的；用專屬 test 資源（獨立 port / path prefix），不撞本機開發環境 |
| **Smoke**（integration 子集） | 真實外部 IO + **小的真實 payload**，驗 download / upload / 解壓 一類 critical path 沒被改壞 | 用真實但極小的 fixture；**不能全 mock**（mock 掉整個 client 就只是測 mock 自己）；每次都跑、要快 |
| **E2E** | 從**最外層 UI** 出發走完整 user story（一個 spec = 一條 story） | 不直接打內部 API（那是 integration 的事）；透過 fixture / chaos endpoint 觸發內部狀態 |

**判層試金石**：「這個 case 真的需要啟 server / 接外部才測得到嗎？」不是 → 不該落到 integration。Integration 慢是 trade-off，不該被濫用。

**E2E 反例**：把 e2e 當 integration 寫（直接 `fetch /api/...` 不走 UE），違反「e2e = 從使用者視角驗收」的設計目的。

## 2. real-not-mock 紀律

「我寫一個 fake DB client / fake storage」= 你只是在測那個 fake 對不對。真實 API 行為一變、test 還是綠的、prod 死。

- **Integration 用真實的**：真 DB、真 filesystem（用 pytest `tmp_path` 之類的真目錄、真 IO，不用 in-memory fs mock），外部資源開一個**測試專屬 path prefix / namespace**（不污染 prod）+ session 級 setup / teardown。
- **E2E 用真實模組**，不用 fake 替身：要走完整真實路徑才叫端到端。
- **Mock 只留給少數情境**：外部行為穩定但太慢 / 太貴 / 不可控的邊界（例：測 retry 邏輯，mock 一個「會失敗 N 次再成功」的 client）。Mock 是例外，不是預設。

### Red flags（過度 mock 的味道）

- **mock 掉整個 filesystem**（pyfakefs 等）→ 你在測那個 fs 假件，不是測自己的程式。改用真實的暫存目錄。
- **mock 掉整個外部 service / client** → 真實 API 行為改了、test 不會紅、prod 才死。改用測試專屬 fixture data + 真實連線。
- **smoke 路徑把 HTTP client 整個 mock 掉** → 號稱測 chunk download，實際只測 mock。smoke 一定要真實小 payload。
- **驗的是「呼叫了哪個內部方法幾次」而不是最終狀態 / 輸出** → 測互動不測狀態，重構一動就假紅 / 假綠。

## 3. Async 測試：等真完成，不要睡

長流程（subprocess、streaming、SSE / WebSocket、背景 job）的測試不能靠時間賭。

- **不要 `sleep(N)` / `setTimeout` 賭它好了** —— 機器慢一點就 flake。改成**等真實完成信號**：drain 到結束、await 一個明確的 ready / done 事件、或讀 process 印出的 sentinel（例：server 啟動最後一行印 `__READY__`，fixture 偵測該行才繼續，同時監控 process 是否中途死掉）。這是 zero-flake 的握手。
- **streaming 回應別直接 `.json()`** —— 串流沒有完整 JSON，要逐行解析；每個 event 收進 list，最後對 `events[-1]` 做 assertion。
- **一定要設 timeout 上限** —— SSE / 串流可能無限等，固定一個 worst-case 上限（例：30s）才不會卡死整套。
- **斷線重連分開測**：mock 一次連線中斷（kill TCP / block proxy）→ 驗 client 端重連 + resume。

## 4. 新 repo / data-layer 覆蓋清單

新建專案或新增資料層（entity / repository / migration）時，光測 happy path 不夠。逐項問「這條有沒有測」：

- **ID 格式**：產生的 id 形狀對嗎（長度 / 前綴 / 字元集 / 唯一性）。
- **Unicode**：中文 / emoji / 組合字 / 雙向文字進得去、存得回、查得到，不會被截斷或亂碼。
- **Constraints**：unique / not-null / foreign-key / check 違反時有如預期拒絕，錯誤可辨識。
- **Boundary**：空值、空字串、最小 / 最大值、超長輸入、0 與負數、超出範圍。
- **重複 / 衝突**：插入既有 key、並發寫同一筆、upsert 行為。
- **往返一致性**：寫進去再讀出來完全相等（round-trip），序列化 / 反序列化不丟資訊。
- **錯誤路徑**：查不存在的 id、刪已刪除的、更新被改過的，回傳 / 拋錯如契約所述。

happy path 一條、error path 至少一條，是 data-layer 的最低門檻。

## 5. 其他硬規則

- **零 skip**：預設 skip = 把已知壞掉的 case 偷偷藏起來。要嘛修要嘛刪，不留中間狀態。真的平台特定跑不了（macOS-only 測試在 Linux）才條件 skip，且原因寫在 marker 訊息裡。「太慢所以 skip」= 該切 smoke 層或拆掉；「flaky 所以暫時 skip」= 永久 debt，改成 fail 或刪掉逼自己處理。一行 `316 passed` 比 `300 passed, 16 skipped` 有意義 100 倍。
- **測試要 Prove-It**：寫完想一下「如果功能根本沒做，這條會紅嗎？為什麼紅？」 測試必須**能因正確的原因失敗**，否則它只是裝飾。
- **固定測試 port / 資源，不用 random**：random 看似避衝突，實際上 log 沒一致 port 難 debug、並行還是有撞的機率（flake 來源）。用專屬 test port（與 prod 不同），開 server 前先清乾淨殘留 process。並行 worker 用 `BASE_PORT + worker_id`。
- **測完 repo 要乾淨**：fixture 要自己清（teardown wipe scratch / cache / 殘留檔）。跑完 `git status` 必須乾淨（除了預期的 ignored runtime 目錄）；不乾淨就是 fixture lifecycle 漏寫 cleanup。fixture 要**自我癒合**：每個 setup 先「探測現有狀態 → 收斂 → 再做事」，假設前次 session 可能 crash 殘留，不能用「先刪再建」這種只走樂觀路徑的寫法。
- **重構改名用 LSP，不用 sed**：bulk text-substitution 在「local 變數名與 module / package 名同形」時會無聲爆掉（語法 valid、import 不報錯、只有真跑到那條路才 AttributeError）。優先用 IDE / LSP 的 rename refactor（它走 AST、分得清 symbol 與字串）；沒 LSP 時先把 local 變數改掉再改模組名、分兩段 commit，改完用 grep 人工掃一遍命中。**unit 跑綠不夠**，要跑一輪 smoke / integration 才驗得到 attribute access。
