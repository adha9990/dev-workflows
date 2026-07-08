# Change Summaries 三段式

> build 階段產出 `stages/03-build.md` 的交接格式，也是 build → verify 之間的精煉 context（讓 verify 不必重讀全部原始 diff）。三段固定。

## 模板

```markdown
## CHANGES MADE
<這次實際改了什麼：哪些檔、加了什麼行為、為什麼>
- <file:區域> — <改動 + 對應哪個任務 / 需求>
- …

## THINGS I DIDN'T TOUCH (intentionally)
<刻意沒動的東西，以及為什麼沒動 —— 防止 reviewer 誤以為漏了>
- <某模組> — <為什麼這次不碰（out of scope / 風險 / 既有行為要保留）>
- …

## POTENTIAL CONCERNS
<我自己看到、想先讓 reviewer 知道的疑慮或取捨>
- <疑慮> — <為什麼擔心 + 目前怎麼處理 / 待 verify 確認>
- …
```

## 填寫守則

- **CHANGES MADE** 對齊紅綠軌跡：每個任務的「Red 確認 → Green 確認 → Refactor」結果落在這裡。
- **THINGS I DIDN'T TOUCH** 是給 reviewer 的反誤判護欄 —— 明說「這不是漏掉，是刻意」。
- **POTENTIAL CONCERNS** 主動暴露取捨，不藏；對應的 commit（Save Point）清單一起附上。
- 套 **Metric-Honesty**：寫「測試綠」就要真的跑過，沒跑標 `not measured`。
