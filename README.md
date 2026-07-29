<!-- loops-artifact: readme@1 -->
# dev-workflows

> 個人開發工作流 plugin marketplace（測試性）。目前 **1 個 plugin**：

| Plugin | 用途 | 怎麼用 |
|---|---|---|
| **loops-workflow** | 7 階段閉環開發工作流（**既有專案**內加功能 / 設計 / 修問題）+ 內建 greenfield 專案 scaffold | `/loops-workflow:dispatch <一句話>` |

**先讀哪一份**：想直接開工看下面的〈最短開始〉；想知道一條 loop 會發生什麼、你要在哪把關 → [`docs/WORKFLOW-GUIDE.md`](docs/WORKFLOW-GUIDE.md)；要裝／換外部來源 → [`docs/SETUP-GUIDE.md`](docs/SETUP-GUIDE.md)。完整索引在 [`docs/README.md`](docs/README.md)。

**CI**：push 到 `master`、開 PR 會自動跑全部 hooks/scripts 測試 + skill-lint（ubuntu + windows 雙平台）。

## 安裝

```
/plugin marketplace add adha9990/dev-workflows  # 從 GitHub 加入 marketplace（owner/repo 簡寫）
/plugin install loops-workflow@dev-workflows    # 閉環開發 + 內建 greenfield scaffold（單一 plugin）
/reload-plugins
```

## 最短開始

```
/loops-workflow:setup                      # 一次就好：問你要哪些外部來源，重跑安全
/loops-workflow:dispatch <你想做的事>       # 之後都用這個
```

`dispatch` 會判斷這是什麼類型的工作、幫你把 issue 開好、然後一路跑到 PR；空資料夾則會先確認再建骨架。`setup` 管的是外部來源（程式碼圖、評測、token 最佳化…）——**不裝也能用，只是少了那幾項能力**。

## 常見情境

| 你想要 | 怎麼做 |
|---|---|
| 開始一件新工作 | `/loops-workflow:dispatch <一句話>` |
| 接續中斷的工作 | `/loops-workflow:dispatch <slug>`（自動偵測並重建狀態） |
| 看某條 loop 跑到哪 | 開 `.loops/<slug>/PROGRESS.md`（每回合自動重生） |
| 裝／換／停用外部來源 | `/loops-workflow:setup`（重跑安全，選擇沒變就什麼都不動） |
| 某個來源壞了想回復 | `/loops-workflow:setup` → 看 receipt 的回滾欄；詳見 [`docs/SETUP-GUIDE.md`](docs/SETUP-GUIDE.md) |
| 想搞懂剛做完的東西 | 完工時產的 `deliverables/explain.md` |

## Codex Preview

除了 Claude Code，這個 marketplace 也可以裝進 **Codex**（目前是 Preview）。完整的安裝步驟、hook 信任、第一個安全 smoke task，以及目前每項能力量到什麼程度，見 [`docs/CODEX-QUICKSTART.md`](docs/CODEX-QUICKSTART.md)。

---

# loops-workflow（plugin）

## 一句話

你打**一個**指令 `/loops-workflow:dispatch <想做的事>`，它就把這件事跑完一條「開發產線」：判斷你要做什麼 → 探索做法 → 拍板規劃 → 寫 code（測試先行）→ 獨立審查 → 修到好 → 開 PR。**全程只在真正該你拍板的地方停下問你**（選做法 / 拍板方案 / 完工），其餘自己往下；你隨時能插話喊停或改。各階段產出寫進 `.loops/<slug>/` 的 markdown 當「階段間記憶」，中斷了也接得回來。

> 📊 想看每階段用哪些 agent / 機制的**完整流程圖**（含 mermaid）→ [`plugins/loops-workflow/docs/FLOW.md`](plugins/loops-workflow/docs/FLOW.md)；**共用規範目錄** → [`plugins/loops-workflow/docs/REFERENCES.md`](plugins/loops-workflow/docs/REFERENCES.md)；**架構與兩張圖的差別** → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 兩個指令

**`/loops-workflow:dispatch <一句話 / 票號 / slug>`** —— 開始或接續一條 loop。判類型、開一條 loop、自動往下跑；**輸入既有 loop 的 slug 就自動接續**（resume）。

**`/loops-workflow:setup`** —— 安裝與對帳外部來源。問你要哪些、只套用差異、**重跑安全**。詳見 [`docs/SETUP-GUIDE.md`](docs/SETUP-GUIDE.md)。

其餘能力都不是指令：

| 你想要 | 怎麼做 |
|---|---|
| 接續中途的 loop | `dispatch <slug>`（自動偵測 `.loops/<slug>/loop.md`） |
| 看某條 loop 跑到哪 | 直接開 `.loops/<slug>/PROGRESS.md`（恆開 hook 每回合自動重生；開場也會自動浮出 active 迴圈） |
| 空資料夾建全端 TS 骨架 | `dispatch` 偵測到乾淨專案、確認後自動走內建 scaffold |
| 工程師理解包 | 完整迴圈完工**一律產**（標準／加強檔位＝`deliverables/explain.md`，三份 deliverable 之一；直行檔位＝合併進 `deliverables/delivery-note.md`）；其他情境用自然語言請 Claude 跑 `explain` skill |
| 維護 repo 的 `AGENTS.md` | iterate 完工命中維護時機由主線依 docs-policy 直接編輯；或自然語言請求 |
| 自動連跑（auto） | 環境變數 `LOOPS_AUTO=1`（見 `references/shared/runtime/auto-mode.md`） |

## 內部怎麼跑（下面這些你不用打、dispatch 自動驅動）

除了 `dispatch` 與 `setup`，其他 skill 全標了 **`user-invocable: false`——不會出現在 `/` 選單**，一律由 dispatch 內部驅動：

```
前置（dispatch 視情況先走）：scaffold 建骨架

define ─H1─▶ plan ─H2─▶ build ─H3─▶ verify ─H4─▶ finalize ─H5─▶（交付）
                          ▲            │
                          └────────────┘（有問題：修 → 再驗一輪）
```

**H1–H5 是「停得下來、也交得出去」的點**：你只要開 issue、只要規劃、只要施工交 QA、只要驗一份 PR——講明就會停在對應的那個點，並留下一份**交接文件**（做完了什麼、還沒做什麼、下一位從哪接）。換人、換機器、換 session 都接得回去：接手時會先確認來源版本、目標有沒有改、產出還在不在，**通過就不重跑已經做完的部分**。

**這張圖不要求每次都從最左跑到最右**：已經有 issue 就從 plan 開始，已經有核准的計畫就從 build 開始，只要驗一份 PR 就從 verify 開始並停在 H4。

> **只在真正該你選的決策點才停**（結構化提問，見 `plugins/loops-workflow/references/shared/delivery/interaction-adapter.md`）：plan 拍板 / 完工或回環 / 真正的 scope 取捨 / 內容型交付的載體 / 安全停（分類模糊·危險操作·P0·規格不清）。**其餘 routine 轉場直接往下**，產出寫進 `.loops/`。**修完一定再過一輪 verify**（不是「測試綠」就算完）。需要時設 `LOOPS_AUTO=1` 開 opt-in 自動連跑——但 auto **不會跨過你指定的停點**。

### 三個「不是階段」的東西

它們過去各佔流程圖上一格，結果是：從 plan 起跑的工作沒有目標可依據、規劃到一半要補查現況卻沒有落點、還沒理解現有實作就開始問問題。現在它們是**任何階段都能用的能力**：

| | 是什麼 | 誰在用 |
|---|---|---|
| **工作契約**（Goal Contract） | 做完長什麼樣、誰受益、承諾哪些行為、什麼算做完 | define 建立、plan 載入、PR 回饋時對帳（**reviewer 講的話不會自動變成新目標**——要改目標得你拍板） |
| **探索**（Explore） | 去看現況：現在怎麼運作、有什麼可重用、有什麼限制 | define 問第一個問題**之前**先看、plan 設計前看、build/verify 只補缺口 |
| **決策佇列**（Decision Queue） | 一次只問一個問題，答完重算還要問什麼 | define、plan（「要不要開工」是獨立的最後一題） |

### 每個階段在做什麼

「停下問你？」欄：✋ = 一定停下開結構化決策點的真決策點；其餘只在列出的條件才停。**下表是階段名、不是指令**——你打的永遠是 `dispatch`，它才是唯一入口。

| 階段 | 停下問你？ | 做什麼 |
|---|---|---|
| **dispatch**（入口，不是階段） | 僅分類衝突 / 要 scaffold 才停 | 判入口（沒 issue→define / 有 issue→plan / 有計畫→build / PR 回饋→build / 只驗→verify / 研究→plan(research)）＋**決定走多遠**（`stop_after`）＋建 `loop.md`；輸入是既有 slug 就走接續 |
| **define** | 有 blocking 決策才停（一次一個） | **先去看現況**，再用 repo 的 issue 模板開一張 template-ready issue，同時寫下這條工作的**工作契約**（行為收斂成幾條、驗收、限制）→ H1 |
| **plan** | ✋ 拍板方案 | 先讀契約與現況、產出「可重用什麼 / 會影響誰 / 哪裡有風險」三張表 → 決策留痕 + 畫機制圖（拍板時渲染給你看）+ 新套件 ≥3 候選評估 → 拆成能各自驗證的任務 → H2。研究型工作在這裡定研究問題、來源、證據標準與停止條件 |
| **build** | 危險 / 卡關才停 | 逐 slice **依證據選路徑**：低風險 / 沿用既有測試 → 一個 impl-author 做完跑既有證據；風險命中（bug / 安全 / 並行 / 資料一致性…）→ **紅綠分離**（test-author 只看需求寫測試、impl-author 只轉綠不准改測試）→ 條件式重構 → 分段 commit → H3 |
| **verify** | 出 P0 才停 | 先跑**不用派人的機械閘**（型別 / lint / 測試 / 計畫與範圍對帳），過了才同一回合派**依風險選出的獨立 reviewer** 各審一面 + 跑真 app + 對嚴重問題二輪確認 → **逐個承諾的行為核證據** → 判 Ready / 退回 → H4 |
| **finalize** | ✋ 完工 / 回環 | 把 verify 或 PR 回饋分類 → **真問題一律自動全修**（修根因 + 加回歸測試）→ 修完再驗一輪 → 乾淨才收尾開 PR → H5。回環圈數（預設 3）是**軟上限**：到頂只會回報現況給你，**還有沒修完的問題就繼續修**，不會因為「圈數用完」就帶著問題進 PR。**只有最嚴重的一級（P0）是誰都不能繞過的底線**——次一級（P1）照樣會被修完，只是不再由機械閘擋住收尾。**自動連跑時另有絕對上界**（預設 6 圈、`LOOPS_AUTO_MAX_ROUNDS` 可調） |

## 三個引擎

- **投入檔位（loop 級右尺寸化）**：dispatch 一開始先判「這件事該投多少」——**直行 / 標準 / 加強**。它縮的是**固定 ceremony 的體積與輪數**（施工圖厚度、機制圖、對齊留言版型、完工文件份數、回環軟上限），**不縮任何把關**：開票、進 code 前的拍板、獨立審查、機械閘、真機驗證、「重大問題沒清乾淨不准送審」每一檔都照做。三條邊界：**判不出來一律走標準檔**（不是最省的那檔）、**只升不降**（碰到高風險 / 範圍變大 / 冒出未決問題就當下升檔並回頭補做）、**送審前有機械檢查**（宣稱走直行卻改到高風險的東西 → 開 PR 被擋、要求升檔補做）。判準與逐項對照見 `references/stages/effort-profile.md`。
- **build 依證據選路徑**：計畫先為每個行為指定**一份**主證據；風險命中的才走紅綠分離（`test-author` 只看需求、看不到 impl → `impl-author` 只轉綠、不准改 test → 條件式 Refactor → 衝突派 `referee` 裁決），其餘沿用既有測試 / 型別 / smoke。讓測試不會遷就實作，也不會為了「有紅燈可跑」而多寫。
- **verify fan-out**：先跑三道確定性閘，再同回合派 reviewer——**固定 product-contract + code-quality**，其餘（architecture / security / performance / tests）依風險觸發，高風險一律滿 6 軸 + 條件式領域 reviewer + `finding-validator` 二輪，輸出 Ready / Not ready。

## 看進度（直接讀 `.loops/`）

迴圈進度全寫在 `.loops/<slug>/`：`loop.md`（狀態 + Journal 事件日誌）與 **`PROGRESS.md`**（可讀儀表板：mermaid 階段圖 + checkbox + Journal 時間軸）。**免安裝、零 token、跨平台**——開 `.loops/<slug>/PROGRESS.md` 的 markdown preview 即可，由恆跑的 Stop hook **每回合自動重生**、永遠最新；SessionStart hook 也會在開場自動浮出所有 active 迴圈（slug / 階段 / 模式 / 最後一筆 Journal）。

> 機制：`scripts/progress.mjs`（renderer，吃 `loop.md` + `0N-*.md`）由恆跑 Stop hook `hooks/progress-render.mjs` 驅動，每回合對「本 session 正在跑」的 loop 重生 `PROGRESS.md`（靠 session 識別碼比對，已完工 / 別 session 不顯示）。`PROGRESS.md` 寫在主 repo 的 `.loops/`、被 gitignore 涵蓋、不入庫。

## 進階（opt-in）

| 能力 | 入口 |
|---|---|
| 自動連跑（核准一次、危險才停） | 環境變數 `LOOPS_AUTO=1`，見 `references/shared/runtime/auto-mode.md` |
| 競賽 / 投票式編隊（N 方案→評審） | plan / explore 說「用 Fleet」，見 `references/shared/runtime/fleet.md` |
| 跨 session 接續 | `/loops-workflow:dispatch <slug>`（自動偵測既有 loop.md），見 `references/shared/runtime/journaling.md` |
| 機器可驗證計畫 + eval | 計畫塊 `scripts/validate-plan.mjs`（見 `references/stages/machine-plan-schema.md`）/ dispatch 場景評測 `scripts/run-eval.mjs`（見 `references/shared/runtime/eval-harness.md`） |
| 全部開關總覽 | `docs/settings.md` —— settings.json `env` 可設的全部 `LOOPS_*` 參數一頁看完 |
| 工程師理解包 | 完整迴圈完工一律產（標準／加強＝`deliverables/explain.md` 三份之一；直行＝合併的 `deliverables/delivery-note.md`）；其他情境自然語言請 Claude 跑 `explain` skill（唯讀側用） |
| code 工作隔離 | 會動 code 的迴圈（issue / fix）在 **git worktree**（自帶 branch）裡做，不擾動主 checkout；用環境提供的 worktree 進入能力，或 `.claude/worktrees/<issue#>-<slug>`（例 `137-trash-delete-permanent`，**不加 `fix/` 前綴**） |

intent→入口對照與全程操作規則見 `AGENTS.md`（marketplace 根）。

## 結構

```
plugins/loops-workflow/
├── skills/       dispatch（唯一入口）+ 前置 clarify / define / scaffold-fullstack + goal→iterate 六個迴圈階段
│                 + 側用 explain（完整迴圈完工一律產 deliverables/explain.md）
│                 —— 除 dispatch 外全部 user-invocable: false，全量見 docs/FLOW.md 規模表
├── agents/       build 紅綠分離（test-author / impl-author / referee）+ verify 核心 reviewer
│                 + finding-validator + 條件式領域 reviewer + 高風險 -deep 變體 + eval-judge
│                 —— 全量與計數見 docs/FLOW.md 規模表
├── hooks/        SessionStart：浮出 active .loops/ 迴圈；Stop：progress-render 重生 PROGRESS.md（恆跑）
│                 + 把關/觀測（預設值逐 flag 拍板——見 references/shared/runtime/journaling.md 決策表；安全把關預設開、SECURITY 類 opt-in）
├── scripts/      validate-plan / run-eval / loops-scan / progress 等 17 支（含 eval-* 家族 / skill-lint / loops-quality-gate，全量見目錄）
├── docs/         FLOW（完整流程圖）/ settings（可設參數總覽）/ REFERENCES（規範目錄）—— 索引見 docs/README.md
└── references/   共用規範 + 模板（全量與分類見 docs/REFERENCES.md）
```

> 全程操作規則（決策點停、繁中、重用優先、文件紀律、對外溝通、參考檔路徑解析）見 `AGENTS.md`。

