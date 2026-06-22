# Finding 驗證判準（finding-validator 用）

> verify 的 `finding-validator` 對每個候選 blocking finding 做二輪確認時用。
>
> validator 是**獨立的第二輪檢查**：只驗一個特定 finding，**不做新的全面 review、不發明新 finding**，且**唯讀**。

## 何時要驗證

任何 finding 進 `Blocking findings` 之前都要驗證，除非 coordinator 能直接從 code 或明確專案規則驗證它。以下必驗：

- 只有一個 reviewer 報了這個問題；
- 信心 `75`、但依賴周邊 code / caller / middleware / runtime 順序 / 需求解讀；
- 嚴重到會讓最終判定變 `Not ready`；
- 主張違反專案規則 / `AGENTS.md`，要對照改動檔案確認適用範圍。

低價值、會維持 non-blocking 的備註**不必**驗。

## 四問

validator 對每個 finding 回答：

1. **是否真實**：這個問題在被檢視的 code 裡真的存在嗎？還是 reviewer 誤讀了 code / 契約？
2. **是否本次引入**：是這次改動引入 / 新暴露的，還是早就存在的既有狀態（非本次範圍）？
3. **是否已被既有防護處理**：有沒有被 caller / middleware / validation schema / framework 行為 / 既有防護 / 測試 / 專案慣例擋掉了？
4. **修正方向是否對症**：建議的修法有沒有對到實際的失敗模式，還是只壓症狀 / 引入新問題？

## 回傳形狀

```markdown
Validation: validated | rejected | degraded
Reason: <一句話>
Evidence checked:
- <檢查過的檔案 / 規則 / 脈絡>
```

- **validated**：四問都站得住、可當 blocker 用。
- **rejected**：錯的 / 既有且無關 / 已被他處處理 / 純偏好 / 純 linter / 缺依據。
- **degraded**：validator 無法檢視足夠脈絡。degraded 可進「未驗證區域」，但除非 coordinator 能獨立證明影響是 P0，否則不得當 blocker。

## 要 reject 的 False Positive

- 引用的問題在**未變更**的 code 裡，且本次沒有新暴露它。
- 某個 caller / hook / route schema / middleware / transaction / 既有防護已經擋掉這個失敗。
- 只是 formatting / import 順序 / 其他 linter/formatter 層面的事。
- 沒有具體失敗情境的 style / 抽象偏好。
- 與需求明示意圖或專案文件化慣例衝突。
- 講不出哪個使用者 / API caller / operator / 持久化資料狀態會受害。

## Coordinator 怎麼用

- 輸出前合併重複的 validated finding。
- validator 理由保留在報告的 `Validation coverage`。
- rejected 直接丟（除非透露出有用的 non-blocking note）。
- degraded 放「未驗證區域」或 Non-blocking notes，不放 Blocking findings，除非 coordinator 直接證明影響是 P0。
