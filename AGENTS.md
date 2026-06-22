# loops-workflow — 操作規則與指令對照

> 7 階段閉環開發工作流。**以使用者自己的 work-plugins / cto-review 工作模式為重心**，用 **Loops Engineering** 的閉環哲學組織，再用 **agent-skills**（MIT）的成熟做法補填真缺口。完整設計見 `DESIGN.md`。
>
> 這份檔案是 plugin 的「憲法層」：以下 Operating Rules 是**全程不變的共用紀律**，七個階段 skill 預設遵守、不各自重述。任一 skill 與這裡衝突時，以這裡為準。

---

## 1. 三層融合定位（一句話）

work-plugins / cto-review 是**重心與骨幹**（每階段做什麼、繁中規範、gate 紀律、cto-pr-reviewer 六 reviewer 引擎、pm-feature-intake 訪談）；Loops Engineering 是**組織框架**（dispatch 分流、Closed Loop gate、`.loops/` 記憶體、iterate 回環、停止條件）；agent-skills 是**方法基底**，只補 work-plugins 的真缺口（簡化 / 威脅建模 / failure triage / source-driven / context 量化）與借螺絲。

---

## 2. Operating Rules（全程不變的紀律）

1. **對外敘述一律繁體中文**；code identifier、檔案路徑、指令、skill 名保留英文。
2. **Closed Loop —— human gate 不可跳**。每個階段做完就停下等使用者拍板，禁止自己一路 paraphrase 串接把下一階段也跑掉。gate 分兩種性質：
   - **確認 gate**：給使用者看產出對不對（goal / build / verify 後）。
   - **決策 gate**：要使用者做選擇才能往下（explore 選方法 / plan 拍板方案 / iterate 決定回環或完工）。
   - **例外（opt-in）**：使用者明確開 `auto` 模式時，階段間 gate 收斂為「計畫拍板一次」，但危險 / 失敗 / P0 / 規格模糊仍硬停（見 `references/auto-mode.md`）。預設仍是 Closed Loop。
3. **`.loops/<slug>/` 是階段間記憶體**。每階段把結論寫成對應 markdown（見 `DESIGN.md` §10），下一階段只讀精煉版、不重讀原始素材。任一階段被獨立呼叫時，**先讀 `loop.md`** 認領狀態。每份檔保持 **< 2000 行**（context window ≠ attention budget）。
4. **模糊就 surface，不要猜**。需求 / 分類 / 方案不清楚時停下來問，不自行假設往下做。
5. **Metric-Honesty**：任何「效能 / 覆蓋率 / 通過」宣稱，沒有實際跑出來就標 `not measured`，不得憑感覺寫數字。
6. **重用優先、不以 MVP**：動手前先搜既有實作（reuse），in-scope 實作照最高標準做（clean-architecture），不另造輪子。
7. **借鑑歸屬**：直接改寫 agent-skills 內容的檔案，頂部標 `<!-- adapted from addyosmani/agent-skills (MIT) -->`。

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
| 純設計 / 研究 / 技術評估（無 issue） | `/loops-workflow:dispatch <描述>` 或直接 `/loops-workflow:explore` | explore |
| 收到 PR / reviewer 回饋要修正 | `/loops-workflow:dispatch <PR#>` 或直接 `/loops-workflow:iterate` | iterate |
| 需求已清楚、只想把方法拆成可驗證任務 | 直接 `/loops-workflow:plan` | plan |
| 計畫已拍板、要逐任務實作 | 直接 `/loops-workflow:build` | build |
| 改完了、要做 merge 前驗收 | 直接 `/loops-workflow:verify` | verify |
| 不確定該從哪開始 | `/loops-workflow:dispatch <描述>`（會幫你判類型 + 建 loop.md） | dispatch 判斷 |

> `dispatch` 很薄：只做「分類 + 建 `.loops/<slug>/loop.md` + 建議起點 + 交棒」，分完就停在起點 gate，不替你把後續階段跑掉。

---

## 4. 階段順序與回環

```
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈）
                                                        └──▶ 完工（交 PR / 收尾）
```

每兩階段之間都有 human gate（見 §2 規則 2）。`iterate` 最多回環 3 圈，超過就 escalate 給使用者。每次回環在 `loop.md` 記一筆。
