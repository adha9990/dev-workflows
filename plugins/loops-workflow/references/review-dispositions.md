# Reviewer 盯點與共用誤報底線（review-dispositions）

> **全部 reviewer 共用**（隨 `reviewer-severity.md` 一起注入）。兩件事：①每個 reviewer 出手前先知道「這軸特別該獵什麼」；②出手前就先壓掉一批通用誤報，不要先亂報再靠 validator 砍。

## 一、Hunting Dispositions（每軸一句盯點）

盯點是**傾向強、語氣中立** —— 帶著明確的懷疑去找，但 finding 一律要有證據、不是攻擊性文風。orchestrator 派 reviewer 時，把對應這行連同 packet 塞進 prompt。

| Reviewer | 盯點（帶著這個傾向去看） |
|------|------|
| product-contract | 龜毛照字面對 issue：先懷疑「這根本在解別的問題」「partial 被當成完成」 |
| correctness（code-quality） | 假設正常使用者就會送出最不利的輸入；先追失敗 / 並發 / 重複下狀態會不會壞 |
| architecture | 假設違規被 alias / barrel 藏起來了；改了契約就追上下游有沒有漏同步 |
| security | 假設使用者是攻擊者；登入 ≠ 有權限；每個輸入都可能是惡意的 |
| performance | 假設資料量是現在的 100 倍、磁碟 / 網路很慢 |
| tests | 先懷疑每條測試的回歸價值：撤掉實作它會不會紅；是不是只測 mock |
| frontend-ui | 假設網路慢且亂序、使用者狂點；先找假成功與沒同步的視圖 |
| root-cause | 預設這個修法只壓症狀，直到作者證明它修了病根 |
| docs-devex | 假設下一個人照現有文件 / PR body 操作；先找會誤導人的過時內容 |

> 盯點是「特別注意什麼」，不是「一定要生出 finding」。該軸沒觸及就據實回無發現 —— 連 2 輪硬湊 finding 反而是雜訊。
>
> 未列入上表的條件式軸（accessibility / web-performance / observability / ci-cd / migration / processing-reliability / multi-user-concurrency）的盯點見各軸 review reference。

## 二、出手前共用誤報底線（先壓再報）

下面這些**出手前就不要報**（與 `finding-validation.md` 第二輪的壓制清單**同源、各取階段適用子集**，前移到 reviewer 出手前降噪；validator / preflight 階段另含「只是牴觸作者已留痕的決定」那條，那條屬事後判定不前移）：

- **既有且與本次改動無關**的問題（除非本 PR 讓它惡化 / 擴散）。
- **linter / formatter / 型別檢查已經會抓**的（不要人工複述工具會擋的）。
- **純風格 / 命名 / 擺放偏好**，講不出實際後果的。
- 已被 **caller / middleware / schema / framework / 既有 guard / 既有測試**處理掉的疑慮（先確認沒被處理再報）。
- 講不出「會壞成什麼」的**泛泛建議**（"加點測試"、"考慮重構"、"注意效能"）。
- 違反 **issue 本身意圖 / 專案既有慣例**的「建議」（那是要求改需求，不是 finding）。
- 需求 / issue 寫得不好本身 —— 那是 PM / 規格問題，不是這份改動的 blocking finding。

> 每個 reviewer 在共用底線之外，可再套自己那軸的假警報清單（見各軸 review reference）。

## 三、找到一個缺陷就掃同類 + 優先在共用層修（全軸適用）

任一 reviewer 找到一個缺陷（**不只 bug-fix 軸**），出手前先做兩件事：

- **掃同類的所有姊妹點**：同一個 pattern / 呼叫 / 疏漏往往有**多個入口**（例：某處 `recordMany` 無界 → 其他 caller 也無界；某個舊欄位名 → 別處也還在用）。只報 / 只修觸發的那一條，換個入口就復發。找到一個就 grep 同詞根 / 同呼叫 / 同形狀，把同類一起列出。
- **建議修正時優先在「共用層」修**（共用函式 / 基底 / adapter），而非逐呼叫點修——**class 級修法自動擴及所有 caller，call-site 修法不會**。若某類風險（如 bind-limit、未分批、未驗證）在共用入口就能一次擋掉，就別建議在每個呼叫點各修一遍。

> `root-cause-review` 軸的〈同類入口掃描〉是這條規則對 **bug-fix** 的特例；這裡把它**推廣到所有軸、所有 finding**。實例：#219 `merge` 的 `recordMany` 分批只修在**呼叫點**、沒掃到 `remove_from_all_groups` 同一個無界 pattern；正解是把分批修進 `recordMany` **本身**（共用層），一次保護所有 caller。
