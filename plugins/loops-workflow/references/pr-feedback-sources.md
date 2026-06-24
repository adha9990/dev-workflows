# pr-feedback-sources —— 蒐齊 PR 上所有 reviewer 回饋來源（一條都別漏）

> iterate 處理 PR reviewer 回饋（type=fix）時用：把一條都別漏地蒐集 PR 上所有回饋來源。
>
> reviewer 的回饋散在三個以上不同的 GitHub API 表面，**沒有任何單一指令能一次拿全**。最常見的 silent miss 是只看 `gh pr view --json reviews` 的總評就動手 —— 而綁在 code 行上、最具體「這行該怎麼改」的 **inline review comment** 那個欄位**根本拿不到**。漏一個來源 = 漏一批待修項，下一輪 review 又被打回。

## 動手前：先確認在對的 branch 上

修正必須落在 PR 的 head branch，落錯分支整輪白做。蒐集回饋之前先比對：

```bash
gh pr view <N> --json number,title,headRefName,state,url   # 取 PR 的 head branch 名
git branch --show-current                                   # 當前 branch
```

- 一致 → 繼續蒐集回饋。
- 不一致 → **不擅自切 branch**（可能污染當前 worktree 的 in-progress 工作）；告知「PR #<N> 的 branch 是 `<head>`，當前在 `<current>`，建議先 `gh pr checkout <N>` 再繼續」，等確認。
- PR 已 `MERGED` / `CLOSED` → 告知並確認是否仍要處理（可能要在 follow-up PR 補）。

## 三種回饋來源 —— 缺一不可

用單一指令拿不全，這是最容易漏的地方：

| 來源 | 是什麼 | 怎麼取 |
|---|---|---|
| **Review summary 總評** | 每位 reviewer 的整體評論 + 狀態（APPROVE / REQUEST_CHANGES / COMMENT） | `gh pr view <N> --json reviews` |
| **Inline 行內 comment** | 針對特定 code 行的 comment（**最具體、最該修的待修項**） | `gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate`（`--json reviews` **拿不到**） |
| **一般討論串** | PR 對話串裡的 issue-style comment（非綁行號） | `gh pr view <N> --json comments` |
| **CI / checks 狀態** | 失敗的 check（lint / test / build）也是必須處理的回饋 | `gh pr checks <N>` |

```bash
# 取 owner/repo（給 gh api 用）
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

# 1. PR 主體 + review summary + 一般討論串 + linked issue 參照（一次拿）
gh pr view <N> --json number,title,body,state,headRefName,baseRefName,author,url,reviews,comments,closingIssuesReferences

# 2. inline 行內 review comment（必須走 REST API，含 path / line / diff_hunk / body / user）
gh api "repos/$REPO/pulls/<N>/comments" --paginate \
  --jq '.[] | {path, line, original_line, user: .user.login, body, in_reply_to_id}'

# 3. CI / checks 狀態（失敗的也是待處理回饋）
gh pr checks <N>
```

**為什麼 `reviews` / `comments` 用 `--json`**：預設文字輸出會被 tool output 上限截斷（長 PR + 多 round 很容易破），截斷不報錯 = silent failure。**超上限時**（Bash 提示 `Output too large ... saved to: <path>`）**不准只憑 Preview 拆解**，必須 `Read` 那個存檔路徑拿完整內容。

**為什麼 inline comment 單獨走 `gh api`**：`--json` 的 `reviews` 欄只給每位 reviewer 的總評 body，**不含**綁在 code 行上的 inline comment —— 那往往是「這行該怎麼改」最具體的指示，漏掉等於漏掉最該修的部分。`in_reply_to_id` 可還原一條 inline 下多輪往返的回覆關係。

## 只處理「未解決」的回饋 —— 過濾 resolved / outdated

已 resolved（後續 commit 已回應）或針對已改舊 code 的 thread 不該重做。**thread resolution 狀態 REST 拿不到，需 GraphQL** 的 `reviewThreads`：

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{body path}}}}
      }
    }
  }' -f owner=<owner> -f repo=<repo> -F pr=<N>
```

- `isResolved: true` → 已解決，**預設略過**（仍列出供使用者知道，避免「明明處理過又被翻出來重改」）。
- `isOutdated: true` → 針對已改的舊 code，標出來請使用者確認是否仍需處理。
- GraphQL 取不到時 fallback：全當未解決處理，但在計畫裡標明「未能確認 resolution 狀態」。

## 跨來源去重（dedup）

同一個訴求可能同時出現在多個來源（例如 reviewer 在總評提一句、又在某行 inline 講細節；或一條 inline 串有多輪 `in_reply_to_id` 往返）。蒐齊後**收斂成「一個獨立可評估、可修正的待修項」為單位**：

- 一條 review summary 塞三個訴求 → 拆成三項。
- 一串 inline 往返（同 `path` + 同 thread）→ 收斂成一項，以最新一則為準。
- 總評與 inline 講同一件事 → 合併成一項，保留最具體的那筆（通常是 inline，自帶 `path` + `line` 可直接定位）。

去重後的清單才是「真正要逐條處理的待修項」總數，避免同一件事修兩次、或數量虛報。

## 補脈絡：讀 linked issue

`gh pr view` 拿到的 `closingIssuesReferences` 給出 PR 連結的 issue。讀它（`gh issue view <linked-N> --json title,body,comments`）建立**判斷基準**：reviewer 回饋若與原始 issue 需求衝突，應標為「需與使用者確認」而非直接照改。

## Edge cases

- PR 還沒任何 review / comment / 失敗 check → 告知「目前沒有回饋可處理」，停。
- 只有 APPROVE 無修改要求 → 告知「已 approve、無待修項」，確認是否仍要處理某 comment。
- 回饋指向 design / 截圖 → 公開連結用 `WebFetch` 抓，否則請使用者口述要點。

## 跨平台 / 私有 repo

- `gh` 先 `gh auth status` 確認登入；未登入請使用者執行 `gh auth login`。
- 私有 repo 同 public 流程；權限不夠 `gh` 回 HTTP 403，請改用有權限帳號。Enterprise GitHub 用 `GH_HOST` 環境變數。
- Cross-repo PR（fork）：`gh pr view --repo <owner>/<name>`，inline comment 的 `gh api` 路徑也要對應該 repo。
- 非 GitHub 專案（GitLab / Jira）：PR CLI 要換（`glab` 等），但「多來源蒐齊 + 過濾已解決 + 去重」的思路通用。
