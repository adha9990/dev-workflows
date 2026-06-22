# 重用檢查（避免同方法、不同出入口）

> 設計期（plan）與驗證期（verify code-quality）共用。核心一句話：**同一件事不要有兩個入口。**

## 判準：稍異 ≠ 新方法

新增 public 方法 / 函式前，先問「既有的能不能擴充或參數化」。當新方法與既有方法**做同類的事、只差參數 / 出入口** → 收斂成一個參數化方法。

| 反例（各開一個入口） | 應該（參數化既有） |
|---|---|
| `showMessageDialog()` / `showMailDialog()` | `showDialog(Message)` / `showDialog(Mail)` |
| `getUserById()` / `getAdminById()` | `getById(id, role?)` 或同一 repo 方法 |
| `handleClickSave()` / `handleClickCancel()` 各自重寫 | `handleClick(action)` 收斂共用邏輯 |

## 隱蔽重複的三種樣子

- **跨入口**：不同 caller 各包一層做同件事。
- **跨 session**：這次新增的，其實上一輪 / 別人已經做過。
- **跨層**：service 與 util（或前後端）各做一份同邏輯。

## 檢查動作

- 新增方法前 `grep` 既有同詞根 / 同責任的（`showXDialog`、`getXById`、`handleX` 系列就是警訊）。
- 看 body：若兩方法 **80% 相同、參數表幾乎一致、名稱只差一個名詞** → 合併。

## 例外

只有「**語意真的不同**（不同領域概念）」才分開。「只是入口 / 觸發點不同」不算 —— 那要收斂。
