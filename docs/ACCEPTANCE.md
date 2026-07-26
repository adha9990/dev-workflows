# 最終驗收報告



**跑得起來的項目全部通過；有 4 項因環境缺少對應來源而未量測（逐項列在下方，未量測不等於通過）。**

| 通過 | 失敗 | 未量測 |
|---|---|---|
| 14 | 0 | 4 |

## 逐項

| 項目 | 結果 | 查什麼 | 說明 |
|---|---|---|---|
| `registry-compiler` | ✓ passed | policy／component／integration 三表的形狀、互指與衝突 | · scope overlaps：policy "documentation-discipline" 與 "canonical-platform-neutral" |
| `policy-runtime` | ✓ passed | 四級規則編譯，且每支會 deny 的 hook 都有宣告來源 |   · advisory（prompt）：stage-advance-without-asking、surface-ambiguity、cost-awareness |
| `skill-lint` | ✓ passed | skill／agent／reference 的引用、計數與 flag 三方同步 | ⚠ [footprint] plugins/loops-workflow/skills/scaffold-fullstack/SKILL.md — 1189 chars |
| `compat-lint` | ✓ passed | canonical 規則文字守平台中立表面 | （另有 72 筆豁免命中記錄於 notes，見 --json） |
| `codex-plugin-lint` | ✓ passed | 第二個 harness 的 manifest 與投影一致 | ✓ codex-plugin-lint：380 檔全綠，無 finding。 |
| `check-registry-shape` | ✓ passed | registry envelope 形狀 | ✓ check-registry-shape：capability-registry.json 全綠，無 finding。 |
| `check-legacy-paths` | ✓ passed | 沒有扁平舊路徑殘留 | ✓ check-legacy-paths：無舊扁平路徑殘留（allowlist 7 檔已知豁免）。 |
| `check-emit-residual` | ✓ passed | hook 輸出信封沒有殘留的舊寫法 | ✓ check-emit-residual：19 支 production hook 全綠，無決策輸出殘留。 |
| `docs-lint` | ✓ passed | 人類文件的連結／指令／來源／參數與事實一致 | ✓ docs-lint：19 份人類文件全綠，無 finding。 |
| `setup-plan` | ✓ passed | setup catalog 自洽、資格未過的來源不在選單 |   · 未進 wizard：token-optimizer-alternate——還缺 Windows 平台實測、本 harness 上的 hook 掛載順序驗證、rollback 路徑實測、真實 benchmark 對照（非宣稱值） |
| `reference-graph` | ✓ passed | 規範引用圖與基準逐條比對（抓文件漂移） |   基準 c55b3ed0555804f30d26fdbe2275c7ed9d219562｜merge-base c55b3ed0555804f30d26fdbe2275c7ed9d219562｜比對 237 條 real |
| `gen-reviewers` | ✓ passed | 生成的 reviewer 人設與真相源沒有漂移 | gen-reviewers --check：21 檔 + model-effort-policy.md 分層表區塊全部與真相源一致，無漂移。 |
| `hook-tests` | ✓ passed | hook 的 direct／bypass／approval／malformed-state 全套 | 22 支全綠 |
| `script-tests` | ✓ passed | registry／記憶體／policy／setup／optimization／docs 的全部單元與整合測試 | 46 支全綠 |
| `skill-optimizer-run` | — not measured | 對所有支援的 skill 產候選並依序驗收 | 外部來源 `skill-optimizer` 未安裝或未啟用——沒跑就標 not measured，不寫成 passed |
| `prompt-eval-full` | — not measured | 完整 corpus ＋ held-out trajectory | 外部來源 `prompt-eval` 未安裝或未啟用——沒跑就標 not measured，不寫成 passed |
| `token-benchmark-full` | — not measured | 全 corpus 的 token／call／duration 實測對照 | 外部來源 `token-optimizer` 未安裝或未啟用——沒跑就標 not measured，不寫成 passed |
| `symbol-consistency` | — not measured | 符號與引用一致性 | 外部來源 `symbol-aware-editor` 未安裝或未啟用——沒跑就標 not measured，不寫成 passed |

## 未量測的項目（誠實揭露）

這些項目需要對應的外部來源就位才跑得動。**未量測不等於通過**——安裝之後要另跑並回填實測結果。

- `skill-optimizer-run`
- `prompt-eval-full`
- `token-benchmark-full`
- `symbol-consistency`

## 另外實測到的證據

以下是這次驗收**實際跑出來**的數字，不是宣稱。

### 程式碼圖重建

| 項目 | 實測 |
|---|---|
| 狀態 | `indexed` |
| 節點 / 邊 | 6068 / 11164 |
| 排除的目錄 | 16 個（文件、fixtures、scripts 等不需入圖的） |
| 跳過的檔 | 0 |

### `.loops` 遷移、replay 與工作圖重建

輸入是**五條真實 loop 的逐字快照**（四條本 repo 的 ＋ 一條更舊、規模更大的歷史 loop）。

| 項目 | 實測 |
|---|---|
| 遷移的 loop 數 | 5 |
| 舊 Journal 行數 → 事件數 | 72 → 95 |
| 追溯性 | **72/72 行全數可追溯**（每行原文都在事件流裡找得到） |
| 事件流健康度 | 0 個警告 |
| 工作圖重建決定性 | 刪掉整個索引再重建 → **nodes 19 == 19、edges 14 == 14，逐欄位相同** |
| 快照重生決定性 | 同一份事件流重生兩次**逐字相同** |

### 測試與閘

| 項目 | 實測 |
|---|---|
| hook 測試 | 22 支全綠 |
| script 測試 | 45 支全綠 |
| 規範引用圖 | 237 條逐條比對，無漂移 |
| 生成的 reviewer 人設 | 21 檔 + 分層表與真相源一致，無漂移 |
| 人類文件 | 17 份全綠（連結／指令／來源／參數／無具體歷史） |
| 會 deny 的 hook | 每一支都有宣告來源（雙向檢查） |

## 未量測的項目：這代表什麼

四項因為**環境裡沒有對應的外部來源**而沒跑。它們不是「通過」，也不是「失敗」，是**沒有資料**：

| 項目 | 缺什麼 | 要怎麼補 |
|---|---|---|
| `skill-optimizer-run` | skill 最佳化來源未安裝 | 用 `/loops-workflow:setup` 安裝後另跑，並把候選的接受／拒絕理由回填 |
| `prompt-eval-full` | 評測執行器未安裝 | 同上；完整 corpus 與 held-out 的結果回填 |
| `token-benchmark-full` | token 最佳化來源未安裝 | 同上；token／call／duration 的實測對照回填，**沒改善就標 `not improved`** |
| `symbol-consistency` | 符號級編輯來源未安裝 | 同上 |

**因此本次驗收不宣稱「task success / rule adherence 不低於基準線」**——那需要評測執行器就位才量得到。目前能誠實說的是：**所有機械閘全綠、所有測試全綠、遷移與重建的決定性有實測數字**。

## 殘餘風險

| 風險 | 誰負責 | 現況 |
|---|---|---|
| 語意級規則沒有實測遵循度 | repo 維護者 | 評測執行器安裝後補；目前這幾條規則由 skill 正文承接，**不宣稱有保證** |
| token 最佳化沒有實測對照 | repo 維護者 | 忠實度契約與 receipt 已就位並有測試；**實際節省量未量測** |
| 互斥組的另一個實作未通過資格審查 | repo 維護者 | 維持在選單之外；六項資格全部 `not measured` |
| 記憶體層尚未被各階段實際寫入 | repo 維護者 | 資料模型、閘與呈現層已就位並有測試；把階段改成寫事件流是後續工作 |
