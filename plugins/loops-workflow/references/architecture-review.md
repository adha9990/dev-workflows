# 架構審查方法論（architecture-review）

> architecture-reviewer 用：在 clean-architecture / design-patterns 的**標準**之外，這份講**怎麼追** —— 邊界違規常被藏起來，要主動追 graph，不能只看檔名。

## 一、追 contract sync（最常見的真 bug 來源）

介面形狀一改，就追上下游有沒有一起改：

- route schema / request-response shape / serializer / 對外 exported type / 自動產生的型別 —— 改了之後，**caller / serializer / 型別產生器 / 相容性**是否同步更新。
- source / wire / semantic 三種相容性是否被破壞（欄位改名、可空性變、新增必填、移除欄位、分頁形狀變）。
- **自動產生的檔（generated）的 diff 本身不是 finding**：回到 source-of-truth（schema / 定義檔）看有沒有新違規；generated 必須跟 source 走、不可反向手改。

## 二、追 import graph（不要只看檔名）

- 實際確認某層**沒 import 不該 import 的東西**，而不是憑檔案位置猜。
- 查有沒有人用 **alias / barrel（index re-export）/ 間接 re-export** 把違規依賴藏起來 —— 看起來合法、實際跨了邊界。

## 三、追 wiring graph（composition root）

新增 service / adapter、替換實作、改 constructor 依賴時：

- 依賴注入是否完整、是否**只在 composition root** 發生（不在內層自己 new）。
- **所有執行進入點都接齊了嗎**（多個啟動路徑 / 多個 runtime target / 多入口程式很容易只接其中一條）。只接一條而未說明是刻意，視為缺口。

## 四、降級 / 假警報清單（避免亂擋）

以下**降級、不當 blocker**：

- 講不出**具體耦合 / 可替換性 / 出貨後果**的「架構味道」—— 講不出後果多半不是 blocker。
- 純命名 / 檔案擺放偏好、同層內抽不抽 helper 這類風格選擇。
- **既有的邊界違規，本 PR 沒改到、也沒擴散** —— 不報。
- 作者已在計畫 / PR body 留痕說明的刻意取捨 —— 不算 finding（除非它本身也是獨立 bug）。

## 五、Finding 寫法

每筆架構 finding 要寫出**具體後果**（哪條依賴方向錯了會導致什麼難以替換 / 難以測試 / 出貨綁死），不能只說「違反分層」。雙視角：工程視角（哪個 import / wiring / contract）、使用者或維護者視角（日後會卡在哪）。
