# effort-profile —— 投入檔位（loop 級右尺寸化的單一正本）

> **問題**：既有的右尺寸化機制（`risk-map.md` 的 predicate、`verify-triage.md` 的風險梯、
> `evidence-portfolio.md` 的證據階梯、`model-effort-policy.md` 的 tier 分層）縮的都是**加派**那一段——
> 「要不要多派一個 reviewer」「這個 behavior 要不要 test-first」「要不要開 DDD 段」。它們沒有一個
> 在管**每條 loop 都要付的固定 ceremony**：完整施工圖、機制圖、設計審查、對齊 comment、三份完工
> deliverable、收尾裁測 pass、回環軟上限。於是「改一段文案」和「改一條交易邊界」付的**基礎成本
> 幾乎一樣**——局部縮減了，整體沒有。
>
> **投入檔位（effort profile）補的就是這一層**：在入口判一次「這件事該投多少」，用它縮固定
> ceremony 的**體積與輪數**，而**不縮任何 mandatory gate**（見〈地板〉）。這份是檔位值域、判準、
> 每階段 knob、地板與棘輪的**唯一定義處**——`skills/dispatch`（判檔位）、`skills/define`、
> `skills/plan`、`skills/build`、`skills/verify`、`skills/iterate` 都**引用本檔、不各自重述**。

## A. 三個檔位（值域正本在 `references/workflow-vocabulary.json` 的 `effort_profiles`）

| id | 叫它 | 什麼時候是它 | 一句話 |
|---|---|---|---|
| `direct` | 直行 | 小、原因明確、範圍收斂、既有機械證據判得出來、不碰高風險 | 該做的都做，但**不為它生一份沒人會讀的施工圖** |
| `standard` | 標準 | **預設**（判不出來就是它） | 現行完整流程，一個字都沒少 |
| `deep` | 加強 | 高風險 / 大波及面 / 高不確定性 | 滿派、深審、多輪收斂 |

排序 `direct(0) < standard(1) < deep(2)`。**這不是「品質等級」，是「ceremony 體積」**——三個檔位
交付的品質下界完全相同（見〈地板〉），差別只在為了達到那個下界要生產多少中介產物。

## B. 進場判準（dispatch 判一次，機械可核）

**先判 `deep`，再判 `direct`，都不命中就是 `standard`。** 每一條判準都要指得出證據
（issue 內容、預期落點、既有 risk map），**指不出來就當沒命中——只往嚴的方向失敗**。

### B1. `deep`：命中任一即是

| id | 條件 |
|---|---|
| `E-high-risk` | 預期改動觸及 `verify-triage.md` 的高風險硬閘任一（auth／加密／金流／DB schema·migration／對外 API 契約／並發·背景／IaC） |
| `E-predicate` | `risk-map.md` 的 `domain_complexity` 或 `external_or_cross_module_contract` 為 true |
| `E-behavior-risk` | 任一 behavior 的 `risk=high` |
| `E-blast-radius` | 動到被廣泛使用的共用元件 / 核心型別 / 跨多模組契約（代理：fan-in ≥ ~5、public barrel 匯出） |
| `E-unknown` | 做法未定、要先研究才知道怎麼做；或有影響 scope／UX／data／security／architecture／acceptance 的 blocking unknown |
| `E-user` | 使用者明講要謹慎 / 要多方案評估 / 要 Fleet |

### B2. `direct`：**七條全成立**才是（任一不成立 → `standard`）

| id | 條件 |
|---|---|
| `D1` | 不碰高風險硬閘（B1 全部未命中） |
| `D2` | 單一關注點、單一模組——不跨子系統、不跨前後端 |
| `D3` | 沒有新的對外契約、沒有新套件、沒有新架構接縫（不新增 port／adapter／服務／跨層機制） |
| `D4` | 預期 footprint 小：功能面約 **≤2 檔 / ≤50 行**（**預估值，不是硬門檻**——它的作用是讓「其實不小」在進場時就看得出來） |
| `D5` | 「做完了沒」用**既有的機械證據**判得出來（既有測試 / typecheck / lint / 一次 smoke），不需要新的驗證手段 |
| `D6` | 沒有 blocking unknown（`AGENTS.md` 規則 18 的四象限裡沒有未決的影響面項目） |
| `D7` | 使用者沒有要求完整流程 |

> 典型 `direct`：改一段文案、調一處樣式、修 typo／rename／log、補一個明確的邊界判斷、修一個
> 原因已經定位清楚的小 bug、範圍收斂的 hotfix。
>
> 典型**不是** `direct`：「順手把這塊整理一下」（範圍未定，違反 `D2`／`D4`）、「這個 bug 不知道
> 為什麼」（違反 `D6`）、「加個欄位到 API 回應」（違反 `D3`）。

## C. 每階段 knob（唯一正本；沒列在這張表的東西，一律不隨檔位改變）

| 環節 | `direct` | `standard` | `deep` |
|---|---|---|---|
| **define**：issue 內文 | 用 repo template，但只填**問題 / 期望行為 / 驗收**三段；不展開背景與方案比較 | 完整 template | 完整 template ＋ `decision-interview` 訪談 |
| **define**：Unknowns Register | 只列 blocking（`direct` 的判準保證它通常是空的）；**一冒出一條就升 `standard`** | 四象限完整 | 四象限 ＋ blind-spot pass |
| **plan**：施工圖 | **micro-plan（一頁）**：現況一段 → slice（含 `files` 與 change budget）→ evidence → 決策（若有）。**不寫** §1–§4 系統全貌與名詞說明 | `design-plan-schema.md` §0–§9 完整 | §0–§9 ＋ ADR ＋ 契約規格段 |
| **plan**：機制圖 | **免**——`D3` 保證沒有新機制。**只要冒出一個新機制就升 `standard` 並補圖** | 每機制「白話 ＋ 運作流程圖 ＋ 注入接線圖」 | 同 `standard` |
| **plan**：設計審查 | **仍必派、仍是一輪**；輸入是一頁 micro-plan ＋ 落點檔，用 `fast-readonly` tier | 一輪，`broad-review` tier | 多輪至乾淨（硬上限 3 圈），高 tier |
| **plan**：對齊 comment | 精簡版：**要改什麼 / 怎麼驗 / 已知風險**三段，≤15 行 | `plan-comment-template.md` 完整版 | 完整版 |
| **build**：路徑選擇 | **不隨檔位改變**——一律照 evidence portfolio 指定的 primary evidence 選（`risk_triggers` 命中就走紅綠分離，檔位低不是跳過的理由） | 同 | 同 |
| **verify**：核心軸 | 地板兩軸（`product-contract` ＋ `code-quality`），risk map 有觸發照樣加派 | 兩軸 ＋ risk map 觸發 | **六核心滿派** ＋ `security`／`architecture`／`code-quality` 改派 `-deep` 變體 |
| **verify**：真機證據 | 照〈誰跑三問〉判；沒有可見畫面就放非空 `no-ui.md` | 同 | 同 ＋ runtime 主張一律 scripted 量測 |
| **finalize**：完工 deliverable | **一份 `deliverables/delivery-note.md`**（導讀 ＋ 手動驗證 ＋ 成本輪廓三段合一） | `explain.md` ＋ `checklist.md` ＋ `cost.md` 三份 | 三份 |
| **finalize**：收尾裁測 pass | 本輪**沒有測試增量就免**（既有規則；`direct` 多半如此）；有增量照做 | 有增量照做 | 照做 |
| **iterate**：回環軟上限 | **2** 圈 | 3 圈 | 4 圈 |

> **這張表縮的全是「中介產物的體積與輪數」**。它不縮任何一次獨立複查、不縮任何一道機械閘、
> 不改任何一個 behavior 的證據要求。

## D. 地板（floor）：不論檔位一律照做，`direct` 也一樣

這幾條是 `AGENTS.md` 規則 10 carve-out 的「不可省的 gate」在本機制上的投影。**檔位是預算，不是
豁免**——把它拿來繞下面任何一條，就是用右尺寸化當偷工的名目：

1. **issue-first**：每件工作都對得上一張 `define` 建的 issue（規則 12）。
2. **`plan → build` 拍板 gate**：一律停下讓使用者拍板（規則 2）；新套件 / 新決策一律先問。
3. **設計審查必派**：`direct` 縮的是輸入體積與 tier，**不是派不派**。
4. **verify 獨立複查**：`product-contract` ＋ `code-quality` 是所有檔位的下界；高風險硬閘命中
   一律滿六軸，`direct` 這時已經因 `D1` 不成立而不存在。
5. **三道確定性閘**：quality-gate / validate-plan / diff-footprint 每輪照跑；`loops-plan` 區塊與
   change budget 照寫（沒有 budget，footprint 閘等於關閉）。
6. **收圈下界 P0 清零**、**finding 二輪確認**、**真機 receipt**、**未解決 blocking unknown 不得進
   build**、**merge 與 draft→ready 由人**、**Metric-Honesty**。
7. **worktree 隔離**：會動 code 的 loop 一律在獨立 worktree 做（規則 9）。

## E. 棘輪（ratchet）：只升不降

**整條 loop 的檔位只能往上，永遠不能往下。** 理由與 `iterate` §5 的「驗證深度只進不退」是同一條：
一旦某個訊號讓你知道這件事比原本想的重，之後用較淺的手法處理它，等於**在剛看見風險的那一刻
把眼睛閉上**；而且降檔之後「ceremony 變少」看起來會跟「本來就不需要」一模一樣。

升檔觸發（命中即升，**當下就升、不等階段結束**）：

| id | 觸發 | 升到 |
|---|---|---|
| `R-high-risk` | 任何階段發現實際改動觸及高風險硬閘 | `deep` |
| `R-contract` | 冒出新的對外契約 / 新套件 / 新架構接縫 | 至少 `standard`（對外契約 → `deep`） |
| `R-footprint` | 實際功能面 footprint 明顯超出該檔位的量級（`direct`：>2 檔或 >50 行且非計畫內） | 升一檔 |
| `R-unknown` | 冒出 blocking unknown | 升一檔 |
| `R-finding` | verify 出任何 P0，或同一輪 ≥2 條經確認的 P1 | 升一檔 |
| `R-rounds` | 回環圈數達到該檔位軟上限 | 升一檔（同時觸發既有的軟上限回報檢查點） |
| `R-user` | 使用者要求 | 使用者指定的檔位 |

升檔的**動作**（三件，缺一不可）：
1. 在 `loop.md` 把 `投入檔位` 改成新值，並在 Journal append 一筆：`舊檔位 → 新檔位｜觸發 id｜證據`。
2. **補做新檔位比舊檔位多的那些 knob**——不是「從下一階段開始才照新檔位」。典型：`direct → standard`
   要補機制圖與完整對齊 comment（plan 已過就回去補，living plan）。
3. 通知使用者一句（為什麼升、補了什麼）。這是**回報，不是決策點**——升檔不需要使用者同意。

> **降檔要走使用者拍板 ＋ 留痕**，且只有一種合法情況：升檔的**依據本身被證偽**（例如以為碰
> migration，查證後根本沒有）。這時記的是「原判定錯了」，不是「決定少做一點」。

## F. 落點、marker 與機械閘

- **loop.md**：`dispatch` 建檔時寫一欄 `投入檔位：direct|standard|deep（判準 id：…）`；升檔就改這一欄 ＋ append Journal。
- **telemetry**（已建 `telemetry/` 的新制 loop）：檔位決定與每次升檔各記一筆 `workflow.effort-profile-decided`（帶 `profile`／`reasons`／`escalated_from`），`cost.md` 的 Executive Summary 才攤得出「投入檔位 / 升檔次數」。**沒有 telemetry 的 loop 只記 `loop.md` 與 Journal**——cost 報表那兩格會誠實顯示 `not_measured`，**不補一個預設值**（補了跨 loop 比較就被假值汙染）。
- **verify 每輪吐一行 marker**（獨立一行、不藏 code fence，貼進 `stages/04-verify.md`）：

  ```
  <!-- loops-effort profile=direct|standard|deep floor=ok|violated highrisk=yes|no|unknown escalated=<n> -->
  ```

  由 `scripts/effort-profile.mjs --audit <loop-dir> --base <ref>` 產出：它讀 `loop.md` 的檔位欄、
  Journal 的升檔軌跡、以及本次改動的實際檔案清單，判**檔位有沒有低於它自己的地板**。
- **`hooks/pr-gate.mjs` 閘⑨**（`LOOPS_PR_EFFORT_GATE`，預設開，作用 `gh pr create` / `gh pr ready`）：
  **只擋 `floor=violated` 一格**——loop 宣稱走 `direct`，但實際改動碰到了高風險硬閘路徑（`D1` 不
  成立）。處置是**升檔補做**（`R-high-risk`），不是改 marker。`profile=standard|deep`、
  `highrisk=unknown`、marker 缺席 / 解不出來一律放行（fail-open，同閘⑥⑦⑧ 的慣例）。
- **降檔不另設機械閘**：它需要「升檔依據被證偽」這種語意判斷，機械判不了；由本檔文字 ＋ Journal
  留痕承接（依 `docs/POLICY-GUIDE.md` 的四級分類，這條是語意要求、不是硬性不變式）。

## G. 怎麼量「這件事有沒有變好」

issue 問的是「調整前後怎麼比」。答案是**同檔位比同檔位**，不是比全體平均——全體平均會被
「這期剛好接了幾件大工作」整個蓋掉。

| 指標 | 從哪來 | 怎麼比 |
|---|---|---|
| token / USD | `deliverables/cost.md`（由 telemetry 生成） | 同檔位的中位數 |
| agent calls | `cost.md` 的 Agent & Task Detail 列數 | 同檔位的中位數 |
| 等待時間 | `cost.md` 的 Duration 欄 | 同檔位的中位數；量不到就標 `not_measured` |
| 驗證品質 | `cost.md` 的 Quality Yield（findings 發出 / 確認 / 解決） | **`direct` 的 escalation 率是主指標**——升檔率高＝進場判準太鬆 |
| 重工率 | `loop.md` 的回環圈數 ＋ 升檔次數 | `direct` 的平均圈數若逼近 `standard`，代表右尺寸化沒有真的省到 |

**三個誠實邊界**：①本機制上線前沒有分檔位的歷史資料，所以「改善了多少」在累積到可比的樣本前
一律 `not measured`（規則 5）——不得用「理論上省了幾個 subagent」當成實測；②`direct` 的價值要用
**升檔率**驗證，不是用「跑得比較快」——跑得快但一半要升檔，代表判準錯了；③指標本身有代價，
不為了量測另外派 agent。

## H. 與既有機制的關係（各管各的，不重疊）

| 機制 | 它管什麼 | 和本檔的分工 |
|---|---|---|
| `risk-map.md` | **behavior 級**：哪個行為要 test-first、要不要開 DDD／Contract-First、verify 加派哪幾軸 | 它是本檔 `B1` 的輸入之一；本檔管的是 loop 級的固定 ceremony，不改它任何一條 predicate |
| `verify-triage.md` | 核心軸的**上界與退路**（高風險硬閘一律滿軸、沒有 risk map 就退回風險梯） | 上界永遠贏：檔位縮不動硬閘 |
| `evidence-portfolio.md` | 每個 behavior 用哪一份證據 | 完全不受檔位影響——證據要求是地板 |
| `operation-first-move.md` | build 紅燈的**第一步**怎麼起手 | 正交：它管「怎麼起手」，本檔管「整條 loop 生多少中介產物」 |
| `model-effort-policy.md` | 每個 agent 用哪個 tier | 本檔只在 plan 設計審查那一格動 tier，其餘 tier 分層照該檔 |
| `handoff.md` 的 `stop_after` | **走多遠**（停在哪個 checkpoint） | 正交：`stop_after` 管長度，檔位管深度。兩者同時解析、互不覆寫 |
