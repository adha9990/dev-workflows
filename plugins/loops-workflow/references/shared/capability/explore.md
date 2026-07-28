# Explore — 按需檢索能力（capability，不是 phase）

> **為什麼不是階段**：探索不是「跑一次就結束」的工作。定義問題時要先看現況才問得對、規劃時要看架構才設計得動、修 finding 時只要看那一塊、驗收時只要看 delta。把它畫成流程圖上的一格，結果是**該探索的時候沒有落點、不該重探的時候整包重來**。
>
> 執行動作在 telemetry 記成 `research`（repo-aware）。**phase 報表裡不會有 `explore`**。

## 各處各用多少（右尺寸，不是每次都全掃）

| 誰在用 | 用多少 | 目的 |
|---|---|---|
| `define` | 提出**第一個** blocking 決策**之前** | 知道現在怎麼運作、有什麼可重用、有什麼限制、既有行為長怎樣——才問得出不能從 code／docs 直接查到的問題 |
| `define`（每答一題後） | 局部補查 | 先更新 decision graph，再判斷需不需要補探索、下一題是什麼 |
| `plan` | 提出實作／架構問題之前 | 讀 issue、Goal Contract、既有 decisions 與相關 code |
| `build` | 只補 context gap | 指名缺什麼，不重新熟悉整個 repo |
| `verify` | 只看 delta 與波及面 | 這輪改了什麼、影響誰 |
| PR fix | 只看被 comment 指到的範圍與失效範圍 | 不重跑完整功能流程 |
| 研究工作 | 由 `plan(research)` 定義問題、來源、證據品質與停止條件 | 同一份能力，只是停止條件不同 |

## Explore-before-question：提問前要有 receipt

`define` 與 `plan` **第一次向使用者提問之前**，必須已經有對應的 exploration receipt。receipt 的機械形式就是 #218 的共享記憶事件，不另造第二套：

| receipt 事件 | 記的是 |
|---|---|
| `knowledge.claimed` | 查到的事實（架構、約定、契約、reuse 候選、波及面…） |
| `context-pack.built` | 為這次工作組出的 context 切片 |
| `context-gap.detected` | **還缺什麼**——只能指名具體缺口，不得寫「需要更多脈絡」 |

**receipt 不要求長篇 Markdown**。要留給人看時才寫 `.loops/<slug>/explore/<主題>.md`（`exploration-receipt@1`，optional），骨架只有兩節：

```markdown
<!-- loops-artifact: exploration-receipt@1 -->
# 探索 receipt — <主題>

## 查到什麼

- <一句可查證的事實>　來源：`<path 或 symbol>`

## 還缺什麼

- <具體缺口，指名檔案／符號／問題；沒有就寫「無」>
```

## 怎麼查（沿用既有規則，不重寫一份）

第一次接觸一個 repo 時**文檔優先**——先讀 `CLAUDE.md`／`AGENTS.md`／`README`／`docs/`，文檔說得清楚就以文檔為準，只在文檔有缺口才爬 code（做法見 `references/shared/docs/onboarding.md`）。
檢索手法、graph 與實檔的分工、未索引 repo 的處理見 `references/shared/runtime/code-retrieval.md`；
查到的事實怎麼寫成可重用的 claim（provenance、有效性、隔離邊界）見 `references/shared/runtime/shared-memory.md`。
**便宜的先、貴的後**：repo 內部夠就不外搜；外搜先便宜檢索、要更深才升級（憲章規則 10）。

## Red Flags

- 還沒查過現況就開始問使用者「你想怎麼做」——問題會越問越偏，這正是本能力存在的原因。
- 問了一個查 code 或 docs 就有答案的問題。
- 換一個階段就把整個 repo 重新熟悉一遍（該做的是取用既有 claim ＋ 只補缺口）。
- 用「先熟悉專案」當理由重跑完整探索——缺口要指名，不得含糊。
- 為了留痕而生出一份沒人會讀的長篇探索報告。
