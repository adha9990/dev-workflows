# 多人併發審查（multi-user-review）

> multi-user-concurrency-reviewer 用（條件式，**專案屬性觸發**：專案在 `AGENTS.md`/`CLAUDE.md` 宣告多人 / 併發 / 協作使用，且改動觸及共享 / 持久化狀態、授權、或並發變更 path 才派）。以 fresh context **預設「多個使用者會同時打這段 code」**，直到作者證明並發與隔離都處理對。這是獨立複查，補的正是「作者在單人心智模型下寫、沒想到並發」的盲點。

## 一、並發寫入 / lost update

判斷同資源並發變更會不會無聲互蓋：

- 盲目 `UPDATE ... SET ... WHERE id = ?`（不比對版本）＝ last-write-wins。多人同編同一 item / folder / preferences 時，後寫者無聲蓋掉前寫者 → **lost update**。
- 期待的防護：**樂觀鎖**（`version` / `updated_at` / ETag，`WHERE id=? AND version=?`，影響 0 列即衝突回報）、CAS、或明確的合併策略。
- read-modify-write 序列：讀出→改→寫回之間別的使用者插入了寫入 → 有沒有偵測。

## 二、跨帳號授權與隔離（owner / tenant isolation）

多人系統最常見的洞是**越權讀 / 改別人的資料（IDOR）**：

- 每個讀 / 寫有沒有**綁當前 principal 的可見範圍**（`WHERE owner_id = :me` / permission 檢查），還是只靠「id 猜不到」？id 可枚舉就是漏洞。
- list / 查詢型 API 有沒有漏掉 owner / permission 過濾（回傳到別人的資料）。
- 授權檢查在**服務層一致**，還是散在各 route、有的檢有的漏。
- 「新增 owner 過濾」這種改動特別要看**同類入口有沒有一起補**（一個 route 補了、別的沒補 = 半修）。

## 三、交易邊界與競態（check-then-act）

- **先查再寫**（先 `SELECT` 確認不存在再 `INSERT`）在並發下有 race window → 兩個請求都查到「不存在」都寫入。唯一性該用 **DB unique constraint** 兜底，不是應用層先查。
- 該原子的多步驟有沒有包在**單一 transaction**；有沒有被拆成多次往返讓中間態外洩。
- 計數 / 配額 / 餘額並發遞增：用 `SET x = x + 1`（DB 原子）還是「讀出 +1 寫回」（會漂）。
- 隔離級別 / 鎖範圍是否足以擋 phantom、雙寫。

## 四、排序 / oplog / change-feed 一致性

- 並發變更寫進事件流 / oplog 的**順序與衝突解法**：重放 / 跨副本同步會不會分歧。
- 亂序到達、coalescing / debounce 在多來源並發下對不對。

## 五、面向使用者操作的 idempotency 與 read-your-writes

- 重送 / 重試 / 雙擊同一操作（at-least-once、重連）會不會**重複作用**（重複建立 / 重複扣減）→ 有沒有冪等鍵。
- 使用者剛寫完立刻讀：跨連線 / 跨副本 / 快取會不會讀到舊值（read-your-writes 破壞）。

## 六、分工與 Finding 寫法

- 與 `security-reviewer` 有重疊（授權）、與 `performance-reviewer` 有重疊（transaction / 鎖）—— 本 reviewer 的獨到價值是**以「多人同時」為前提串起整條威脅模型**，不是逐點重審。同一問題被兩軸抓到，coordinator 去重即可，別為了不重疊而漏審。
- **作者已在 plan/issue/PR 留痕、明確接受的並發取捨不算 finding**（`preflight.md`）；但作者以「單人使用」為由略過、卻與專案的多人宣告矛盾 → 要標出。
- 每筆：**P0–P3 + Confidence + Route**（`reviewer-severity.md`），工程視角（哪個並發 / 授權 / 交易 path、哪檔哪行、race window、修法）＋使用者視角（多人同時用會踩到什麼）。沒實跑並發情境標 `not measured`。
