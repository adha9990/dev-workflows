# pr-watch —— reviewer 回饋自動接手閉環（設計）

> **2026-07-22 更新（未實作、實作時須對齊）**：本稿多處寫的「內圈 3 圈上限」已被 issue #161 改成**軟上限**——`iterate` 的圈數到頂只觸發回報，**未修的 P0/P1 不得因圈數收圈**（見 `skills/iterate` §5）。哨兵層自己的外圈輪數計數（第 4 輪起不派發、改 escalate）維持原設計；動工前把「內圈照 iterate 既有 3 圈」一律讀成「照 `iterate` §5 當時的規則」。
>
> 2026-07-02 拍板。目標：reviewer 在 PR 上回覆後，本機 AI 第一時間（15 分鐘內）偵測到並自動起修正迴圈，把「人工發現回饋 → 人工起 iterate」的等待時間壓掉，同時守住三條使用者約束：**三圈內收斂、修根因不修表面、有紀錄可回溯且重大改動與結案合併由人處理**。

## 1. 背景與問題

現況：loops-workflow 已有完整的「怎麼正確修 PR 回饋」閉環 —— `references/pr-feedback-sources.md`（三來源蒐齊＋resolved 過濾＋去重）、`skills/iterate`（RECONCILE 四分類、Stop-the-Line 根因修＋GUARD、修完必 re-verify、3 圈收斂感知）、`references/auto-mode.md`（硬煞車清單）。**缺的只有觸發層**：reviewer 標了 CHANGES_REQUESTED，本機沒有任何機制知道，要等使用者人工發現、人工起 iterate，一來一回以小時／天計。

`references/automations.md` 只提了「/schedule 每天掃一次」的概念，未落地；且經查證 **Claude Code 內建 CronCreate 是 session-only**（排程只活在單一 session 記憶體、session 關閉即消失、7 天自動到期、只在 REPL idle 時觸發），撐不起常駐哨兵 —— 耐久排程必須落到 OS 層。

## 2. 已拍板的決策（2026-07-02，使用者逐題確認）

| 決策點 | 拍板 |
|---|---|
| 無人在場時自動化邊界 | **全自動修＋推上 PR head branch**；回覆 comment 發佈、轉 Ready、merge 一律人工；危險／P0／不收斂照 auto-mode 硬煞車停 |
| 監看範圍 | **只監自己（PR author = 本人）的 open PR，含 draft**；同事的 PR 完全不碰 |
| 偵測延遲 | **15 分鐘內**；機器關機不偵測、開機後補掃 |
| 觸發層架構 | **B：cron 哨兵＋每 PR 派獨立 bg job**（偵測與執行分離、多 PR 可並行） |
| 排程宿主 | **Windows Task Scheduler**（前提修正：CronCreate session-only 撐不起常駐；改用 OS 排程後哨兵為純腳本，**空轉 0 token**） |

## 3. 非目標

- 不自動 post 任何對外內容（修正回覆 comment、issue comment）—— 草稿寫 tmp 等人審。
- 不自動轉 Ready、不 merge、不 close、永不 force push。
- 不處理他人 authored 的 PR（連通知都不做，範圍最小化；要擴再說）。
- CI 失敗單獨觸發（無 reviewer 回饋時）預設關閉 —— iterate 被觸發後本來就會蒐 CI 狀態一併處理；獨立的 CI watch 是另一題。
- 非 GitHub 平台（GitLab 等）不在本期。

## 4. 架構

```
Windows Task Scheduler（每 ~13 分，off-minute 錯峰）
  └─ pr-watch-sentinel.ps1（純 PowerShell + gh，0 token）
       ├─ gh pr list --author @me --state open（含 draft）
       ├─ 逐 PR 取回饋水位：review submissions / unresolved reviewThreads（GraphQL）
       │   / issue-style comments，取「非本人發出」的最新時間戳
       ├─ 與 state.json 水位比對；無新回饋 → 直接結束
       └─ 有新回饋（且過了 5 分鐘 quiet window）→ 逐 PR：
            ├─ 安全檢查（lock、輪數、使用者是否正在該 branch 工作）
            ├─ 輪數 ≤ 3 → Start-Process 派發獨立 headless job：
            │     claude -p "<修正入口 prompt>" --settings pr-watch.settings.json
            └─ 輪數 > 3 → 不派發，通知「3 圈未收斂，需要人工檢查點」
```

每個 per-PR job 內部走既有 plugin 閉環：蒐齊回饋（pr-feedback-sources）→ iterate（type=fix、auto）→ RECONCILE → actionable 全修（根因＋GUARD）→ re-verify（fresh reviewers 涵蓋波及面）→ 分段 commit → push → 修正回覆草稿寫 tmp → 通知 → 清理。

## 5. 元件

### 5.1 哨兵腳本 `scripts/pr-watch-sentinel.ps1`

- **輸入**：`$LOOPS_ROOT/.loops/pr-watch/config.json`（監看的 repo 清單，首發只有 eagle-app-core；quiet window、輪數上限等參數）。
- **水位判定**：「新回饋」＝ 任一非本人發出的 review submission / unresolved review thread comment / PR 討論串 comment，時間戳晚於該 PR 的水位。resolved thread 不算（GraphQL `reviewThreads.isResolved` 過濾）。
- **quiet window（5 分鐘）**：最新回饋距今不足 5 分鐘 → 本輪先不派發，等 reviewer 寫完（GitHub review 是批次 submit 通常原子，但散裝 comment 會陸續進來，避免修到一半又來一條）。
- **狀態** `.loops/pr-watch/state.json`（**錨定主 repo root**，依 AGENTS.md 規則 9；必須被 .gitignore 涵蓋）：

```json
{
  "adha9990/eagle-app-core": {
    "193": {
      "watermark": "2026-07-02T07:27:14Z",
      "rounds": 1,
      "lastRunAt": "...",
      "lastOutcome": "pushed | escalated | skipped-dirty | skipped-lock | error"
    }
  }
}
```

- **lock** `.loops/pr-watch/locks/<pr>.lock`：內含派發的 claude 進程 PID＋時戳。**stale 判定＝ lock 內 PID 已不存在**（`Get-Process` 查）；PID 仍存活但時戳超過 2 小時 → **不回收、不重派**，改發通知「pr-<N> 修正 job 疑似卡死（PID x，已跑 y 分鐘）」等人處置 —— 避免長跑中的 job 被誤判重派造成雙重執行。
- **輪數**：每次「針對一批新回饋成功派發」＋1。**重置**：使用者跑 `/loops-workflow:watch reset <PR#>`（授權再繞，對齊 iterate §5），或該 PR 的 reviewDecision 轉為 APPROVED（新一輪 review cycle 從頭計）。
- **使用者在場保護**：派發前檢查主 checkout —— 若 `git branch --show-current` 等於該 PR 的 head branch **且**工作樹 dirty → 跳過＋通知（使用者可能正在改，不搶）。另若 `.claude/worktrees/pr-<N>-fix` 已存在且 dirty → 同樣跳過＋通知。
- **失敗處理**：`gh` 未登入／斷網 → 本輪靜默跳過，連續 4 次（約 1 小時）失敗才發 Windows toast 提醒；同一 PR 派發後以 `error` 收場 → 下輪重試一次，再敗即 escalate 通知並停止自動重試（等人）。
- **收斂清理**：PR 轉 MERGED / CLOSED → 清掉該 PR 的 state 與 lock。

### 5.2 派發與權限外殼

- `Start-Process claude -ArgumentList '-p', '<入口 prompt>', '--settings', '<plugin>/scripts/pr-watch.settings.json'` —— 每 PR 一個獨立 OS 進程，可並行；stdout/stderr 落 `.loops/pr-watch/runs/<時戳>-pr<N>.log`。
- **`pr-watch.settings.json` 用 allow/deny 規則把人工 gate 做成機械強制**（不是叮嚀模型，是工具層 deny —— 對齊 2026-07 遵守性研究「fail-open 靠自律不可靠、硬 gate 才守得住」的結論）：
  - **deny**（無人值守下絕對禁止）：`gh pr merge*`、`gh pr ready*`、`gh pr comment*`、`gh pr review*`、`gh pr close*`、`gh issue comment*`、`git push --force*` / `git push -f*`、`gh repo delete*`。
  - **allow**：iterate 所需的最小集合 —— 讀寫檔、`git fetch/worktree/add/commit/push`（非 force）、`gh pr view/checks/diff`、`gh api`（讀）、測試／lint／build 指令。
  - **`gh api` 寫入漏洞封堵**：只 deny `gh pr comment` 擋不住改走 `gh api` POST 出 comment。deny 需涵蓋 `gh api` 的寫入變體（`-X`／`--method` 帶 POST/PATCH/PUT/DELETE、`-f`/`-F`/`--field`/`--raw-field`/`--input` 帶 body），入口 prompt 同時明文禁止以 `gh api` 發佈任何對外內容；prefix 比對封不乾淨的部分以 §7.2 的實測把關。
  - 其餘不在 allow 內的工具呼叫在 headless 下自動被拒 → job 記錄後停下通知，不會卡住等輸入。

### 5.3 per-PR 修正 job（入口 prompt 模板，放 `references/pr-watch.md`）

入口 prompt 硬性規定（防「skill 在但沒照做」）：

1. **必須走 plugin skills**：依 `references/pr-feedback-sources.md` 蒐齊三來源（inline 必走 `gh api repos/{owner}/{repo}/pulls/<N>/comments`）→ 起 `iterate`（type=fix、auto 模式），不准 ad-hoc 修。
2. **一律開隔離 worktree**：`git fetch origin <headRef>` → `git worktree add .claude/worktrees/pr-<N>-fix origin/<headRef>` —— 把 pr-feedback-sources 的互動規則「branch 不一致 → 等確認」在無人值守下改寫為確定性規則：**永不碰使用者的 checkout，永遠在專用 worktree 工作**。
3. **auto-mode 硬煞車全保留**：P0／危險或不可逆操作／規格不清 → 停、journal 記「因 X 暫停」、PushNotification 通知、結束 job（不硬修、不猜）。
4. **收尾只到 push**：修完＋re-verify 乾淨 → push 到 head branch → 修正回覆 comment 草稿依 `comment-policy` §8 寫到 tmp（**不 post**）→ PushNotification（例：「#193 這輪 5 條已修畢推上，回覆草稿待審：<tmp path>」）→ 清 worktree。
5. **journal 寫回主 repo 的 `.loops/`**：head branch 名對得上 loop slug → append 到該 loop 的 `loop.md` Journal（resume 語意：第幾外圈、修了哪些、findings 數 vs 上輪）；對不上 → 記在 state.json ＋ runs log。
6. **內圈紀律照舊**：iterate 自己的 3 圈＋收斂感知、每修必加回歸測試、修完必 re-verify —— 觸發層不重複實作、也不繞過。

### 5.4 plugin 落地清單

| 檔案 | 動作 |
|---|---|
| `commands/watch.md` | 新增 `/loops-workflow:watch`：`install`（產 config＋註冊 Task Scheduler 排程）／`status`（state 摘要＋最近 runs）／`reset <PR#>`（輪數重置＝授權再繞）／`uninstall` |
| `references/pr-watch.md` | 新增：哨兵協定、state/lock schema、入口 prompt 模板、無人值守適配三規則 |
| `scripts/pr-watch-sentinel.ps1` | 新增：哨兵本體（純腳本、可離線單測） |
| `scripts/pr-watch.settings.json` | 新增：headless job 的 allow/deny 權限外殼 |
| `references/automations.md` | 補「§4 事件觸發（pr-watch）」一節，並修正 /schedule 敘述（CronCreate session-only 的環境事實） |
| `docs/FLOW.md` | 同步：iterate 的 type=fix 來源多了「pr-watch 自動觸發」一條進入路徑 |

## 6. 三條使用者約束的落點

- **收斂三圈內**：外圈（人類 reviewer 圈）per-PR 輪數計數在哨兵層 —— 第 4 輪起**不派發**、改 escalate 通知（「已 3 圈未收斂，需要人工檢查點」）；使用者可 `watch reset` 授權再繞（計數重置）。內圈照 iterate 既有 3 圈＋收斂感知（findings 沒嚴格變少當場 escalate）。兩層都是「escalate ＝ 檢查點，不是放棄」。
- **避免表面修正**：修正紀律全部復用 iterate 既有規範（Stop-the-Line 根因修、每修必加回歸測試 GUARD、修完必 re-verify 且涵蓋波及面、綠燈不能取代 verify）；觸發層唯一的責任是**入口 prompt 硬性指定走 skill**＋權限外殼防繞道。
- **紀錄回溯／重大人審／結案人工**：分段 commit 落在 feature branch（`git revert` 可回、deny 規則封死 force push）；`loop.md` Journal 每外圈一筆＋ `runs/` 執行日誌＋ state.json 水位軌跡；P0／危險→硬煞車停下等人；comment 發佈、Ready、merge 三個對外動作被 deny 規則機械封死，只能人工。

## 7. 驗證計畫

1. **哨兵單測**（離線、mock gh 輸出）：無新回饋／有新回饋／全 resolved／quiet window 內／3 圈滿／lock 被活 PID 佔用／stale lock／使用者 dirty branch —— 各情境的派發與跳過決策正確。
2. **權限外殼測試**：headless job 內嘗試 `gh pr comment`／`git push --force`／`gh api -X POST .../comments`（繞道發 comment）→ 全部被 deny 且 job 正常收尾通知，不掛死。
3. **端到端演練**：開測試 PR、自己用另一帳號（或請同事）留一條 inline comment ＋ CHANGES_REQUESTED → 驗證 15 分內起 job → 隔離 worktree 修 → push → 通知 → 回覆草稿在 tmp、**沒有**自動 post。
4. **失效演練**：斷網一輪、佔住 lock、機器重啟後補掃 —— 均不重複派發、不遺漏回饋。

## 8. 開放問題（實作時定）

- Task Scheduler 觸發間隔取 13 分（off-minute 錯峰）或使用者自訂；筆電休眠喚醒後 Task Scheduler 的 catch-up 行為需實測。
- PushNotification 在 headless（`claude -p`）下的桌面通知行為需實測；不通則 fallback Windows toast（哨兵層代發）。
- 多 repo 支援：config.json 天生是清單，首發只填 eagle-app-core，不另做抽象。
