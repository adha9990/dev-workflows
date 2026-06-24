# loops-workflow — 操作規則與指令對照

> 7 階段閉環開發工作流：`dispatch → goal → explore → plan → build → verify → iterate`，階段間 human gate，`.loops/<slug>/` markdown 當階段記憶體。
>
> 這份檔案是 plugin 的「憲法層」：以下 Operating Rules 是**全程不變的共用紀律**，七個階段 skill 預設遵守、不各自重述。任一 skill 與這裡衝突時，以這裡為準。

---

## 1. 設計取向（一句話）

把一次開發當成一個**閉環**：每階段做一件事、寫進 `.loops/` 交給下一階段，**只在真正要選的決策點停下讓人把關**（見規則 2，routine 轉場不問）。發散工作（探索、驗證）派多個 subagent 各做不同子任務、收斂工作回單一主線；build 用紅綠分離防測試遷就實作、verify 用多 reviewer fan-out 擴大覆蓋。

這個閉環的座標（明寫，免得只是「跑階段」）：

- **類型 = Closed Loop（預設）**：人類在框架內把關、隔離環境（worktree）、清晰標準、持續驗證 —— 適合大多數實際產品工作；opt-in `auto` 收斂成 Open Loop（核准一次後連跑，只剩安全停）。
- **規模 = 單一迴圈（預設）**：一個主線跑完整條；解法空間寬 / 長任務時 opt-in **Fleet 編隊**（plan·explore·verify 派多 subagent 並行各做子任務再收斂，見 `references/fleet.md`）。
- **目標的脈絡 = VISION / ARCHITECTURE / RULES**：VISION＝issue / `00-goal.md` 完工定義；ARCHITECTURE＝`02-plan.md` 設計書（§0–§9）+ repo 既有架構（onboarding 文檔優先讀）；RULES＝本檔 + 專案 `AGENTS.md` / `CLAUDE.md`。三者就是每個 subagent 該拿到、且只拿到的脈絡。

---

## 2. Operating Rules（全程不變的紀律）

1. **對外敘述一律繁體中文**；code identifier、檔案路徑、指令、skill 名保留英文。
2. **推進：階段間不問「要不要進下一階段」**。階段做完把產出寫進 `.loops/` + chat 摘要，**直接往下**，**不要**每進一個階段就停下問使用者「要不要繼續」。使用者隨時可插話喊停 / 改方向。
   - **只在「真正要使用者選」時停 + 用 `AskUserQuestion`**（選項標推薦，依 `references/comment-policy.md`）：explore 選方法 / plan 拍板方案（含套件選型）/ iterate 完工 or 回哪階段；以及 goal / plan 冒出的**具體 scope / 取捨決策**（有真選擇才問，沒有就往下）。
   - **安全停（一定停 + 問）**：dispatch 分類模糊 / 危險不可逆操作 / verify 出 P0 / 規格講不清。
   - **絕不**用純文字「請回覆 yes / 要我接著進 X 嗎」要使用者打字 —— 要嘛 `AskUserQuestion`，要嘛直接往下。
   - **auto 模式**：連上面的決策也用推薦選項自動帶過，只剩安全停（見 `references/auto-mode.md`）。
3. **`.loops/<slug>/` 是階段間記憶體**。每階段把結論寫成對應 markdown（`00-goal.md` / `01-explore.md` … 每階段一個），下一階段只讀精煉版、不重讀原始素材。任一階段被獨立呼叫時，**先讀 `loop.md`** 認領狀態。**進入一個階段時更新 `loop.md` 的「當前階段」+ append 一筆 Journal**（供 statusline / resume）；**完工時把「當前階段」設為「完工」**。每份檔保持 **< 2000 行**（context window ≠ attention budget）。
4. **模糊就 surface，不要猜**。需求 / 分類 / 方案不清楚時停下來問，不自行假設往下做。
5. **Metric-Honesty**：任何「效能 / 覆蓋率 / 通過」宣稱，沒有實際跑出來就標 `not measured`，不得憑感覺寫數字。
6. **重用優先、不以 MVP**：動手前先搜既有實作、避免重複造輪子（稍異 ≠ 另造，優先參數化既有方法，見 `references/reuse-check.md`）；in-scope 實作不以 MVP，照最高標準做（對可預見的規模退化預先用對演算法）。
7. **文件紀律**：完工前依 `references/docs-policy.md` 判斷 —— 新子系統 / 跨切面 / 不直觀設計寫 `docs/<topic>.md`（+ 維護 `docs/README.md` 索引）；慣例 / 規則改變才更新 `AGENTS.md` · `CLAUDE.md`；小功能不塞 docs。
8. **對外溝通**：所有面向人的書面（AskUserQuestion / issue · PR 回覆 / 驗收報告 / 端決策）依 `references/comment-policy.md` —— 繁中白話、雙視角紀錄、AskUserQuestion 標推薦、對外內容先寫**暫存 tmp 草稿**校稿（不進專案 / 不進版控）+ **送出後刪 tmp**、不寫客套。
9. **code 變更在 git worktree 裡做**（隔離工作目錄、不擾動使用者主 checkout）：會動 code 的迴圈（issue / fix）在 loop 啟動時開一個**獨立 worktree（自帶 branch）**、整條 loop 在裡面跑 —— **不在主 checkout 直接 `checkout -b`**。用環境的 worktree 能力（`EnterWorktree`）或 `git worktree add .claude/worktrees/<slug> -b <slug> <base>`。**branch / worktree 名 = loop slug `<issue#>-<slug>`（例 `137-trash-delete-permanent`），不加 `fix/`/`feat/` 等 type 前綴**；修正型（PR 已存在）把該 PR branch checkout 進 worktree。純設計 / 研究（不動 code）免開、走到 build 再開。完工 merge 後 `git worktree remove` 清掉。**`.loops/<slug>/` 留在主 repo（session 起點 / 主 checkout）、不放進 worktree** —— worktree 只放 code。原因：未追蹤的 `.loops/` 若放 worktree，會在 worktree 被 `git clean` / refresh（`baseRef: fresh`）/ `remove` 時被**一起刪掉、毀掉 audit trail**（已踩過）；放主 repo 才不被 worktree 操作波及，主 repo 的 session 也直接讀得到。statusline / `status` / hook 仍會掃 `.claude/worktrees/*/.loops/` 當保險。
10. **成本意識：迴圈很貴，要設計成「負擔得起」**。一條迴圈動輒 50–200K token、回環三輪 500K–2M —— Loop Engineering 的成敗在**負擔得起**，不是能不能跑。所以全程貫徹：
    - **高上下文效率**：下一階段只讀**精煉版**（`.loops/` 的 `0N-*.md`）、不重讀原始素材；每份 < 2000 行；subagent 只塞它**需要的那段**脈絡（VISION/ARCHITECTURE/RULES 對應段 + 該軸的絕對路徑 reference），不倒整包。
    - **便宜的先、貴的後且要 gate**：explore 內部夠就不外搜、外搜先便宜 `WebSearch` 再 gate 升級 deep-research；verify 條件式 reviewer 只在觸及領域才加派；Fleet / deep-research / 真機驗證這些貴動作預設不開、要才開。
    - **不重複勞動**：reuse 優先（不重造輪子）、living plan（偏離回去改、不留到最後重做）、修完一定再 verify（一次驗到位、不靠人來回）。
    - **fail-fast 不空轉**：停止條件明確、回環 3 圈上限、**不過早放棄也不無限繞**。
    省 token 不是吝嗇，是讓迴圈**能負擔得起地跑到完成**。

### 參考檔路徑解析（重要）

`references/*.md` 的讀取分兩種情境：

- **主線（執行 skill 者）**：依 skill 載入時顯示的 base directory 解析（`<base>/../../references/xxx.md`）。
- **subagent（被 build / verify 派出的 persona）**：CWD 是使用者 repo、且 `${CLAUDE_PLUGIN_ROOT}` 在 markdown body **不會展開**（Claude Code 已知限制），相對路徑 `references/xxx.md` 解不到。因此**派 subagent 的 orchestrator skill 必須**從自己的 base directory 推出 plugin root，組出 reference 的**絕對路徑、寫進該 subagent 的 prompt**；persona 一律「讀 prompt 提供的絕對路徑」，不自己用相對路徑。

---

## 3. Intent → command 對照表

使用者可以走 `dispatch` 讓系統判類型，也可以**直接喊對應階段**跳過判斷。每個階段 skill 都能獨立呼叫。

| 你想做的事 | 進入點 | 起點階段 |
|------|------|------|
| 有 issue 號 / 「做這個 issue」（完整迴圈） | `/loops-workflow:dispatch <描述>` 或直接 `/loops-workflow:goal` | goal |
| 想解決 / 實作一個**還沒開 issue** 的問題 | `/loops-workflow:dispatch <描述>`（先幫你建 GitHub issue → 再 goal） | 建 issue → goal |
| 純設計 / 研究 / 技術評估（無 issue） | `/loops-workflow:dispatch <描述>` 或直接 `/loops-workflow:explore` | explore |
| 收到 PR / reviewer 回饋要修正 | `/loops-workflow:dispatch <PR#>` 或直接 `/loops-workflow:iterate` | iterate |
| 需求已清楚、只想把方法拆成可驗證任務 | 直接 `/loops-workflow:plan` | plan |
| 計畫已拍板、要逐任務實作 | 直接 `/loops-workflow:build` | build |
| 改完了、要做 merge 前驗收 | 直接 `/loops-workflow:verify` | verify |
| 不確定該從哪開始 | `/loops-workflow:dispatch <描述>`（會幫你判類型 + 建 loop.md） | dispatch 判斷 |
| 想看懂一份改動 / 交給人前產導讀 | `/loops-workflow:explain <target>` | 側用（唯讀，不進迴圈） |
| 想裝 statusline（顯示當前 loop / 階段） | `/loops-workflow:install-statusline` | 側用（一次性設定，patch settings.json） |

> `dispatch` 很薄：只做「分類 + 建 `.loops/<slug>/loop.md`（+ 對 issue/fix 開 worktree）+ 進起點階段」，routine 轉場不問，但不替你把整條 loop 自動跑完。

---

## 4. 階段順序與回環

```
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈）
                                                        └──▶ 完工（交 PR / 收尾）
```

只在真正要選的決策點停（見 §2 規則 2，routine 轉場不問）。`iterate` 最多回環 3 圈、且**修完一定再 verify**（完工只在 verify 乾淨那輪可達），超過就 escalate。每次回環在 `loop.md` 記一筆。
