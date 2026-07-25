# commit 規範

> build 分段 commit 時用。**title 與 body 敘述一律繁體中文**；type / scope / code identifier / footer trailer 保留英文。

## 格式（Conventional Commits）

```
<type>(<scope>): <繁中主旨，動詞開頭>

<body：為什麼這樣改，不是改了什麼；風險 / review 重點>
```

- **type**（英文小寫）：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `style`。
- **scope**（英文）：從 repo 結構推導（模組 / 子系統名），不是固定清單。
- **主旨**：繁中、動詞開頭、**≤ 72 字元**；用精確動詞（「修正」「補上」「收斂」），不用糊弄詞（「更新」「處理」「調整一下」）。

## inspect-before-draft

寫 message 前先 `git status` / `git diff --staged --stat` / `git log --oneline` 概覽（`context-diet.md` §B：需逐行內容寫 body 才開 full diff、限定路徑）—— message 要對齊**實際 staged 的 diff**，不是憑印象。

## commit splitting

- **分離**：production code / tests / docs / generated / formatting 各自一筆。
- **可合**：一個 feature 與它的 test 可同一筆（`feat` 帶測試）。
- 一個 commit 一個邏輯單位 —— build 每完成一個邏輯單位就分段 commit（Save Point）。
- 大改動用 `git add -p` 切細；**不要 `git add .` 一把梭**。

## body 寫什麼

why-not-what：解釋動機 / 取捨 / 風險 / 給 reviewer 的脈絡。code 本身已經說明「改了什麼」，body 補的是「為什麼」。

## 紀律

- 不 amend 已 push 的 commit。
- commit history 是事故取證 / changelog / blame 起點 —— 每筆都要能獨立讀懂。
