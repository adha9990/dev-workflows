# 交接 — <slug> · <checkpoint 標籤>

> 這份文件的意思是：**這次被要求做的範圍已經完成，停在這裡是刻意的**，不是出錯、不是中斷、不是還沒做完。
> 下一位（不論是別人、別台機器，還是下一個 session）從這裡接手，不必重新定義、重新探索、重新規劃。

## 交接摘要

| 項目 | 內容 |
|---|---|
| checkpoint | `<checkpoint>`（<標籤>） |
| 停在這裡的原因 | <requested-scope／safety-stop／blocked> |
| Goal Contract 版本 | revision <n> |
| 來源版本 | `<source_revision 或 not_measured>` |
| 下一個入口 | `<next_entry 或 —（終點）>` |
| 建議接手的人 | <pm／architect／engineer／qa／repo-owner> |

## 已完成

<這次真的做完了什麼。一項一行，寫得出證據的附證據（issue URL／commit／指令輸出）。>

## 未完成

<還沒做、留給下一位的。沒有就寫「無」——空著與「刻意沒有」分不出來。>

## 產出

<這次產生的受管產物路徑或 URL。>

## 接手須知

<下一位要先知道的事：已決定的取捨、還沒解的 unknown、以及**不要重做**哪些已經做完的工作。
量不到的一律標 `not_measured`，不要寫成看起來合理的值。>
