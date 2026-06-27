# preflight —— 交付 / 送審前的作者自檢

> 交付 / 送審前的作者自檢：loops-workflow 用 verify ⇄ iterate（+ explain）當這道關，本檔補上四關編排、單一送審判定、與『作者決定不是 finding』硬規則。
>
> 對象是**作者自己**：在把改動交給人類 / 外部 reviewer（開 PR、請審）之前，先以作者視角把完整審核鏈跑一輪，提前抓到會被退回的問題。輸出只給作者看 —— 不打分、不張貼 GitHub、不替代真正的審核。
>
> 可在兩個時機跑：**送審前**（要交 PR 了，最後一關）；**開發中段**（想確認方向對不對，用 branch 模式）。PM 公開審核標準的本意就是「開發過程中自己對照」，不是送 PR 前才拿來應付。

## 已經有的：loops-workflow 怎麼覆蓋 preflight

preflight 的三道關，loops-workflow 既有階段**已經做掉大半**，本檔不重造：

| preflight 關卡 | loops-workflow 既有對應 | 覆蓋程度 |
|---|---|---|
| Merge-readiness（合併安全） | `verify`：核心 reviewer fan-out（含 code 全 6 軸 product / architecture / security / performance / code-quality / tests；純文件 / 設定依 §1.4 右尺寸化到最小集）+ 條件式 reviewer + `finding-validator` 二輪 | **完全等價**。verify 就是 merge-review 引擎本身，連 finding 驗證、P0–P3 分級、Ready/Not ready 收斂都有 |
| Implementation walkthrough（實作導讀） | `explain` 第 1 段：進入點 / 責任盒 / 介面邊 / payload 流動 + mermaid 圖 + `file:line` 證據錨點 | **完全等價** |
| Ownership rehearsal（面談預演） | `explain` 第 2 段：5 題 ownership 自測（需求 / 設計取捨 / 實作流程 / API 用法 / 防呆驗證）+ 參考解答 | **完全等價** |
| Design-direction（設計方向） | `explain` 第 3 段：一句話講工程方向 + 指出有沒有偏離 issue 契約 | 有 recap，但**不是 pass/fail 關卡**（見下節缺口 a） |

所以送審前自檢 = **跑一輪 `verify`（拿合併安全結論）＋ 跑一次 `explain`（拿導讀 + 自測題 + 方向 recap）**。多數情況這兩個就夠。

## 缺口：preflight 多出來、本檔補上的三件事

### (a) 單一「我準備好送審了嗎？」判定

verify 輸出 `Ready / Not ready`，explain 輸出理解包 —— 但**沒有人把兩者收成一句「可不可以送出去」**。preflight 補上這個收斂層：把 design-screen（方向對不對）＋ ownership rehearsal（自己答得出來嗎）＋ merge-review（verify 結論）三者合成**單一送審判定**，三選一：

| 判定 | 條件 |
|---|---|
| `可送審` | 無 validated P0/P1；設計方向沒偏離 issue 契約；核心行為有測試 / 驗證證據。剩餘 P2/P3 與打磨建議列為可選 |
| `建議先修` | 任一 validated P0/P1（來自 verify）、或設計方向偏離 issue 契約、或核心行為缺驗證證據 |
| `資訊不足` | 任一軸缺關鍵脈絡且該缺口擋住整體判斷；明說缺什麼，不硬給結論 |

修正清單依嚴重度排序（P0 → P1 → P2 → 可選打磨）。

**design-screen 升級成 pass/fail**：explain 的方向 recap 平時只是「描述 + 提醒」；在 preflight 裡它變成關卡 —— 方向偏離 issue 契約（且作者沒留痕拍板要偏離）就直接 `建議先修`，因為方向錯時，細節修再多都白費。

### (b) 跨關去重

design / walkthrough / merge-review 三軸常常從不同角度撞到**同一個根因**。收斂時：同一根因只留一條，標註哪幾關都看到了（多關共見 = 信心加分）。這比 verify 內部的 coordinator 去重多一層 —— verify 只去重 6 個 reviewer 之間，preflight 還要再去重「verify 結論 ⇄ explain 方向 recap」之間的重疊。

### (c) 硬規則：作者已留痕的決定不算 finding

這是 preflight 最關鍵、也最容易被違反的一條。自檢的審核契約是**上游 issue / 需求**，不是作者在 alignment comment、`02-plan.md`、PR body 裡的自述。

**判準**：一條 finding 若只是**牴觸了作者已留痕的決定**（alignment comment / `02-plan.md` / PR body 寫明的拍板），就**不是有效 finding**，整條剔除（不降級、直接剔除）—— **除非**它同時是一個**獨立的正確性 / 安全 / 資料缺陷**（亦即就算沒有那個決定，它本身也是 bug）。

拆開講：

- 作者**已拍板的決策**（含刻意推翻 issue 字面的決策，例如選了不同實作策略）是**定案**，不是「該修」也不是「該準備辯護」的 finding —— 拿作者的話回頭審作者沒有意義。
- 決策的**已知取捨與後果**（作者自己寫明的）同樣不是問題。
- 作者的**事實陳述**（例如「測試全綠」）若無法證實，歸入「還沒驗證的地方」，不質疑、也不當成謊報。

子代理 / reviewer 只該回報三類：

1. 作者可能**沒注意到**的真實 code / 正確性 / 安全 / 效能 / 資料缺陷；
2. 與作者決定**無關**的獨立缺口；
3. 實作**牴觸了作者自己的決定**（說一套做一套 —— 計畫寫 A、code 做 B）。

> 派 reviewer 時，把這條規則原文塞進每個子代理的 prompt（子代理不共享 context，沒寫進 prompt 就看不到）。**不可**出現「重點審查作者的偏離」這類引導 reviewer 回頭審決定的措辭 —— 那會讓自檢把所有刻意決策都誤報成問題。

## 怎麼跑（送審前自檢流程）

### 輸入契約（雙模式）

審核契約是**上游 issue**，沒有契約就沒有 design-screen 與 product-contract 那一軸。缺 issue 時先用一句話要 issue 編號。

- **PR 模式**：給 PR 號 / 連結（缺 issue 就從 PR body 的 `Closes #N` 推）。要 checkout 時，working tree 為 dirty 就停下回報、不切分支。
- **Branch 模式**：給 issue 編號，審當前分支；diff 基準用 `git merge-base HEAD origin/master`。開發中段自檢用這個。

### 步驟

1. **備自檢 packet**（之後塞進每個 reviewer 的 prompt）：issue 重點（目標 / 範圍 / 驗收 / 非目標）、作者自述意圖（branch 模式改讀 alignment comment / `02-plan.md` / commit log）、diff 摘要與檔案清單、最近的 `AGENTS.md` 規則，以及 **作者已拍板決策清單**（從 alignment comment / `02-plan.md` / PR body 整理出的定案與已知取捨 —— 這份就是 (c) 規則的比對基準）。
2. **跑 merge-review**：跑一輪 `verify`（核心 reviewer〔含 code 6 軸、純文件 / 設定依 §1.4 右尺寸化〕+ 條件式 + finding-validator）。把 (c) 硬規則原文加進每個 reviewer 的 prompt。
3. **跑 design + walkthrough + ownership**：跑一次 `explain`，拿三段理解包。
4. **收斂**：先套 (c) 過濾（把誤把作者定案當問題的 finding 整條剔除）→ 再做 (b) 跨關去重 → 出 (a) 單一判定。

### 唯讀紀律

PR 模式只在準備階段 checkout 一次，之後所有 reviewer 一律唯讀 —— 不准再 checkout / 切分支 / 改檔案（避免多個子代理同時動同一個 working tree 打架）。預設不跑 test / lint / CI，但「核心行為要有測試或明確驗證證據」照常適用 —— 缺證據本身就是有效 finding。

## 輸出（白話風格，不丟結構化表給作者）

主體模仿真人 reviewer 在 PR 上的寫法，**不要把 6 個 reviewer 的原始輸出直接貼給作者**：

1. 開場一段：肯定方向 + 一句判定（`可送審` / `建議先修` / `資訊不足`）+ 點出要修哪幾類。
2. 每項問題用固定四段（沿用 verify 的雙視角）：**會發生什麼情境**（什麼操作 / 資料狀態踩到、caller / 使用者看到什麼）→ **為什麼是問題**（正確性 / UX / 架構 / 安全 / 資料一致 / 驗證上的風險，含哪檔哪裡）→ **建議怎麼修**（方向，不寫完整 patch）→ **建議補測試**（regression / contract test，或「無」）。
3. 收尾：`建議先修` 時「修完 blocking 再送審」；`可送審` 時給下一步（接 PR）。

完整原始輸出（5 題自測題庫 + 解答、walkthrough 的 component map、各軸的 Severity/Confidence/Route）全部收進 `<details>` 技術版，不混進主體。永不張貼 GitHub。

## 紅旗自查

| 念頭 | 事實 |
|---|---|
| 「作者這決定跟 issue 字面不同，列一條 finding」 | 先查 alignment comment / `02-plan.md` —— 留痕拍板過的就是定案，剔除（除非它本身也是獨立 bug）。 |
| 「為了完整，把 explain 跟 verify 都從頭重做一遍邏輯」 | 別重造 —— merge-review = 直接跑 `verify`，walkthrough/ownership/方向 = 直接跑 `explain`。preflight 只加收斂層。 |
| 「verify 出 Ready 了，那一定可送審」 | verify 只管合併安全。送審判定還要過 design-screen（方向沒偏）與 ownership（自己答得出來），三軸合一才算。 |
| 「順手把 findings po 上 PR」 | 自檢永不碰 GitHub 寫入。要留檔走 `comment-policy.md` 的 tmp 檔流程。 |
| 「報告直接貼六個 reviewer 原始輸出」 | 主體要白話收斂；原始輸出進 `<details>`。 |
