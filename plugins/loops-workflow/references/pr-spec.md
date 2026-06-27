# 發 PR 規範

> iterate 完工收尾交 PR 時用。標題與 body 敘述繁中（identifier 英文）。

## 開法

- **開 Draft PR**（先草稿，確認再轉 Ready）。
- **標題**：`<type>: <繁中主旨> (#<issue>)`，例 `feat: 補上訂單關鍵字搜尋 (#122)`。
- **指派給作者本人**：`gh pr create --assignee @me`（既有 PR 用 `gh pr edit <PR#> --add-assignee @me`）—— PR Assignee 標成作者自己。

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

- **開 / 改 PR 時自動與 master 同步**：`git fetch origin master` 後若 branch 落後 / 與 master 衝突 → **自動把 master 合進 branch**（`git merge origin/master`）並解衝突（謹慎解、不盲目取單邊；真的解不清才停下用 `AskUserQuestion` 問），解完 push —— **不留帶衝突 / 落後的 PR**，再請求 review。
- 送出前對外內容（PR body / 回覆）先寫 tmp 草稿給使用者校稿（見 `references/comment-policy.md`），確認才 post。
- **開 / 改 PR 後驗證 `gh pr view <PR#> --json closingIssuesReferences` 已含目標 issue**（body 的 `Closes #<issue>` 生效了），不是空陣列。

## merge 策略（單一來源）

PR 經使用者**核可後**才合併（**human-gated、絕不 auto-merge**）；核可後一律用 **squash**，讓 master 每個 PR 只進**一個 commit**、歷史線性：

```
gh pr merge <PR#> --squash --delete-branch \
  --subject "<type>: <繁中主旨> (#<PR#>)" \
  --body "<精煉成果 + Closes #<issue> + Co-Authored-By / Claude-Session trailer>"
```

- **必帶 `--squash`**（不是預設的 merge-commit）—— 不留「Merge pull request」合併節點、不保留分支內多筆 commit；整個 PR 壓成一筆乾淨 commit、好讀好 revert。
- **顯式帶 `--subject` / `--body`**：主要為**控制 squash commit 訊息** —— 繁中 subject + body 內 `Closes #<issue>`（merge 時自動關 issue）+ Co-Authored-By / Claude-Session trailer，不讓 GitHub 從分支多筆 commit 自動拼湊；附帶也免去 `gh pr merge` 在 non-interactive 環境開編輯器 / 報錯。
- **編號來源**：subject 尾綴 `(#<PR#>)`（squash commit 慣例、用 **PR 號**）、`Closes #<issue>` 放 **body**（用 **issue 號**）。PR 號 ≠ issue 號是正常，別把 subject 的 PR# 改成 issue#。
- `--delete-branch`：合併後刪遠端分支（本機分支 / worktree 由 `skills/iterate` §6 收尾清理）。
- merge **本身仍是 human gate** —— 使用者核可才執行；這段只規範「核可後用什麼策略合」，不改「誰決定 merge」。
