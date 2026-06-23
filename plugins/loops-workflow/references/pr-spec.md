# 發 PR 規範

> iterate 完工收尾交 PR 時用。標題與 body 敘述繁中（identifier 英文）。

## 開法

- **開 Draft PR**（先草稿，確認再轉 Ready）。
- **標題**：`<type>: <繁中主旨> (#<issue>)`，例 `feat: 補上訂單關鍵字搜尋 (#122)`。

## 連結 issue（關閉關鍵字，必做）

issue-driven PR 的 **body 開頭必須放關閉關鍵字** `Closes #<issue>`（單獨一行、英文），例 `Closes #137`。

- 這才會讓 GitHub **正式連結 PR ↔ issue**（issue 的 Development 區塊顯示此 PR）+ **merge 時自動關閉 issue**。
- 標題的 `(#137)` 與內文「修正 issue #137」**只是 mention** —— 只在 issue timeline 留一條 cross-reference，**不算連結、不會自動關閉**。
- 關鍵字**必須英文**：`Closes` / `Fixes` / `Resolves`（中文「關閉 #137」無效）。多個 issue 各寫一行。
- 驗證：`gh pr view <PR#> --json closingIssuesReferences` 應列出該 issue（**不是空陣列**；GitHub 處理有幾秒延遲，空的就重查）。

## body 第一樓 = 實作成果書

把這次的「完工定義 + 實作計畫 + 真實成果」整合成 PR body 第一樓（**最開頭先放 `Closes #<issue>`**，見上節）：

- 做了什麼、為什麼這樣設計（從 `.loops/` 的 goal / plan / build 提煉）。
- 成果展示（實際跑出來的證據：測試輸出、畫面、driver 結果）。
- **不含** 內部設計更新流水帳 / commit 列表 / 後續迭代記錄 —— body 是「單一最新真相」。

## edit-first 紀律

- PR **還沒有其他 reviewer**（只有作者本人，含自己跑的自檢）→ 一律 **edit 第一樓**，不開新 comment。
- PR **出現其他 reviewer 的 comment 後** → 每輪修正發**新 comment** 回覆（第一樓仍同步成最新成果）。

## 收尾

- 與 master / 主幹 merge 同步、解衝突後再請求 review。
- 送出前對外內容（PR body / 回覆）先寫 tmp 草稿給使用者校稿（見 `references/comment-policy.md`），確認才 post。
- **開 / 改 PR 後驗證 `gh pr view <PR#> --json closingIssuesReferences` 已含目標 issue**（body 的 `Closes #<issue>` 生效了），不是空陣列。
