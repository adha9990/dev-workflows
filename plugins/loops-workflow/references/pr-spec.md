# 發 PR 規範

> iterate 完工收尾交 PR 時用。標題與 body 敘述繁中（identifier 英文）。

## 開法

- **開 Draft PR**（先草稿，確認再轉 Ready）。
- **標題**：`<type>: <繁中主旨> (#<issue>)`，例 `feat: 補上訂單關鍵字搜尋 (#122)`。
- **指派給作者本人**：`gh pr create --assignee @me`（既有 PR 用 `gh pr edit <PR#> --add-assignee @me`）—— PR Assignee 標成作者自己。

## 連結 issue（關閉關鍵字，必做）

issue-driven PR 的 **body 開頭必須放關閉關鍵字** `Closes #<issue>`（單獨一行、英文），例 Closes #137。

- **必須是純文字、絕不可包在反引號 / code span 裡**（寫成 `` `Closes #137` `` 會被 GitHub 當程式碼、**不解析、不連結** —— 踩過：`closingIssuesReferences` 會是空陣列）。
- 這才會讓 GitHub **正式連結 PR ↔ issue**（issue 的 Development 區塊顯示此 PR）+ **merge 時自動關閉 issue**。
- 標題的 `(#137)` 與內文「修正 issue #137」**只是 mention** —— 只在 issue timeline 留一條 cross-reference，**不算連結、不會自動關閉**。
- 關鍵字**必須英文**：`Closes` / `Fixes` / `Resolves`（中文「關閉 #137」無效）。多個 issue 各寫一行。
- 驗證：`gh pr view <PR#> --json closingIssuesReferences` 應列出該 issue（**不是空陣列**；GitHub 處理有幾秒延遲，空的就重查）。

## body 第一樓 = 實作成果書

把這次的「完工定義 + 實作計畫 + 真實成果」整合成 PR body 第一樓（**最開頭先放 `Closes #<issue>`**，見上節）：

- 做了什麼、為什麼這樣設計 —— 把設計決策 / 機制圖（mermaid）**inline 寫進 body**（GitHub 渲染）。`.loops/` 的 goal/plan/build 是**提煉來源**，**絕不在 body 連結 `.loops/<doc>` 路徑**（`.loops/` 不上 GitHub、merge/close 後清除＝死連結；見 `comment-policy.md §0`）。要指更細只指 PR/commit/`file:line`/issue。
- 成果展示（實際跑出來的證據：測試輸出、畫面、driver 結果）。
- **設計決策只寫「做了什麼 + 為什麼」，不在其中列「不做 / out-of-scope」**。**deferred / 不做 / 後續工作（含分相位 descope 的部分）→ 開一則 follow-up comment 記錄**（輕量追蹤；不在 body 設計決策裡敘述、**也不自動開 issue**——要開 issue 由使用者決定）。
- **不含** 內部設計更新流水帳 / commit 列表 / 後續迭代記錄 —— body 是「單一最新真相」。

## body 公版（fill-in 骨架 — 白話優先）

複製下面骨架填空、刪掉不適用的段。**這是給人讀的**：先講「做什麼、為什麼」，術語能避就避、非用不可就**當場一句白話解釋**，用具體例子（回傳範例、前後對照）勝過抽象描述；機制圖（mermaid）只在真的幫理解時才放。工程流水帳留給 commit / `.loops`，別塞進 body。

反例 → 正例（拿捏「白話」）：
- ✗「batched GROUP BY 消除 N+1、jobs-probe 由 O(N) 降 O(active jobs)」　→　✓「原本清單上每個庫各跑幾個小查詢、庫一多就慢；改成整頁一次算完，大庫也快」。
- ✗「INDEXED BY 強制 partial index 命中」　→　✓（多數情況根本不用提；真要講就）「加了索引讓『這個庫有沒有在處理』查得快」。
- ✗ 丟複雜度符號 `O(...)`　→　✓「平常很快，只有 <某情境> 當下會稍慢、且是暫時的」。

~~~md
Closes #<issue>

## 這個 PR 做了什麼
<一兩句白話：加 / 改了什麼、給誰用、解決什麼痛點。>

## 主要改動
<條列每個改動點，每條白話。動到 API / 對外契約 → 給「回傳長這樣」範例，並白話說明每個欄位是什麼。>

## 相容性 / 權限 / 邊界
<有沒有動 schema / 對外契約 / 權限；相容嗎；邊界行為（錯誤碼、archived、空值…）怎麼處理。都沒有就寫「無」。>

## 效能 / 影響（相關才留，否則整段刪）
<白話：原本怎樣、改成怎樣、現在的界限。用「平常很快，只有 <情境> 時稍慢、且暫時」這種說法。>

## 怎麼驗證的
<幾個測試過、涵蓋哪些面向；有跑真 app / 截圖就寫。>

<repo 慣例的 trailer：Co-Authored-By / Claude-Session，或 🤖 footer>
~~~

> **deferred / 後續工作不寫進 body** —— 依上節規則另開一則 follow-up comment 追蹤（body 保持「單一最新真相」）。

## edit-first 紀律

- PR **還沒有其他 reviewer**（只有作者本人，含自己跑的自檢）→ 一律 **edit 第一樓**，不開新 comment。
- PR **出現其他 reviewer 的 comment 後** → 每輪修正發**新 comment** 回覆（第一樓仍同步成最新成果）。

## 收尾

- **push ≠ merge：push 不需 gate、只有 merge 需**。開 PR / 同步 master / 補 commit 後**自動 `git push` branch**，**不要停下等使用者說「push」**——push 只是把已 commit 的東西送上遠端，唯一的 human gate 是 **merge**。同理，plugin 維護 / 其他 repo 的 commit 也**自動 push**（別擱著「等使用者決定 push」——那不是 gate）。（實測教訓：曾把 plugin commit 擱在本機不 push、使用者得回頭要求。）
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

## worktree / 分支清理時機（refine `skills/iterate` §6）

- **worktree 保留到 PR close / merge**：solo review 流程下 PR 開著期間，使用者可能還要在該 branch 的 worktree 跑 / 檢視（例如 `pnpm dev` 在獨立 portless 子網域驗證改動、不擾主 checkout）→ **loop 完工不立即刪 worktree**，**等 PR merge / close 後**才連同分支一起清（`--delete-branch` 刪遠端、本機 worktree 這時再 `git worktree remove`）。iterate §6 已對齊此規則：**有開著的 PR 時 worktree 保留到 PR merge / close 才清（§②）**，只有「沒交 PR 的純中止」才在 loop 結束（§①）連 worktree 一起清；**tmp 草稿 / 截圖等其他暫存仍在 loop 結束就清**（只有「PR 開著時的 worktree」延後）。
- **Windows 檔案鎖**：`git worktree remove --force` 常因 `node_modules` 被 TS server / esbuild / vitest 佔用而失敗（`Directory not empty` / `Device or resource busy`）。此時 **`git worktree prune` 仍會把它從 `git worktree list` 除名**（git 層已乾淨）；殘留目錄**未被 git 追蹤**（`git status` 顯示為 `?? .claude/…` untracked——新目錄 git 不會自動追蹤、要 `git add` 才會入庫）、**不入庫、無害**，待鎖釋放（關 IDE / 下個 session）再手動刪即可。**別為刪一個被鎖的目錄卡住流程**；也**別在 PR 還開著時就去刪 worktree**（見上條）。
