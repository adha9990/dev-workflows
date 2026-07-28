# shared-memory — 跨階段共享的 Agent 記憶（單一正本）

> 同一條 loop 的**共同事實只探索一次**：第一個 repo-aware 階段把它查到的事實寫成 claim，之後的階段與 subagent 從 context broker 取自己需要的那一小塊，不再各自把架構、約定、caller chain 重新理解一遍。與 `context-diet.md`（產生端輸出瘦身）、`code-retrieval.md`（怎麼查 code）分工不重疊：那兩份管「一次查詢怎麼便宜」，這份管「查過的東西怎麼不再查第二次」。

## A. 三條鐵律

1. **共享事實、不共享結論**。可以共享：架構、檔案／symbol 職責、依賴與呼叫關係、專案約定、API／schema／event 契約、domain invariant、reuse 候選、波及面、怎麼跑（test／lint／smoke／cleanup）、以及**仍對同一 revision 有效**的執行證據。不可繼承：某個方案「最好」、code「已正確」、finding「成立／已修好」、PR「可以 Ready」、作者或前一位 reviewer 的辯護與判定。**結論在 claim 的型別白名單裡沒有位置**——寫了會在 append 當下被拒。
2. **沒有 provenance 就不是 valid**。每條 claim 帶來源與 digest；來源拿不到 digest、code graph 取不到 revision 時，一律落到 `uncertain`／`not_measured`，**不得猜成 valid**。使用前保守補查，不當既成事實。
3. **記憶不寫成敘事**。claim 是「一句可查證的事實 ＋ scope ＋ 來源 ＋ 有效性」，長內容留在 repo／code graph／既有 artifact。給人看的 `stages/*.md`、`deliverables/*.md` 照 artifact contract 產（那是給人的）；**不為 agent 記憶另寫一份長篇 Markdown**——那只是把重複探索換成重複生成與重複閱讀。

## B. 什麼時候寫 claim

第一個真的去查 repo 的階段（多半是 `define`／`goal`／`explore`）在得到可查證的事實時就寫下來；後續階段只在**補查缺口**或**來源改變後重查**時再寫。寫入一律走：

```bash
node <plugin-root>/scripts/knowledge-ledger.mjs   # 由呼叫端 import 使用；事件一律 append 進 .loops/<slug>/events.jsonl
```

一條 claim 的欄位：`claim_id`／`kind`／`statement`（一句話，有長度上限）／`scope.files`＋`scope.symbols`／`sources[]`（type＋locator＋digest）／`graph_project`＋`graph_revision`（用到 code graph 時）／`confidence`／`validity`／`created_by`（phase＋agent_role）／`created_at_revision`／`derived_from`（衍生自哪幾條）。合法值域一律查 `references/workflow-vocabulary.json` 的 `knowledge` 區段，**不自己發明 kind**。

## C. 派工前：拿一份 context pack

repo-aware 的派工（會查或會改 code 的：research／design／implement／execute-test／review／validate-finding／remediate／reverify）**一律先產 pack、再派**：

```bash
node <plugin-root>/scripts/context-pack.mjs <loop 目錄> --stage <phase> --role <role> --task <id> --affected <p1,p2> --revision <git sha> --budget <n> --record
```

`--record` 會順手把這份 pack 登記進事件流（`context-pack.built`）——**產 pack 與登記 pack 分兩步就一定會有人只做前者**，然後在派工當下被擋下、回頭補一次。把輸出的第一行 `loops-pack` marker 原樣放進 subagent 的 prompt（與 trace envelope 並存，兩者管的事不同：envelope 管成本歸戶，pack marker 管「它拿到的是哪一份脈絡」）。缺 marker、marker 指到沒登記過的 pack、或 pack 引用的事實已失效，派工會被擋下。放行時「這份 pack 被誰用掉、用掉了哪幾條事實」由 guard 自動記回事件流，不必自己補。

pack 依 **stage × role × task × 波及範圍 × 有效事實 × 獨立性邊界 × token budget** 決定內容，是 deterministic 且 content-addressed 的：同一組輸入永遠算出同一個 `packId`。它會誠實列出「因預算沒放進來的」與「因獨立性邊界不提供的」——**兩者分開列**，前者多給預算就拿得到，後者這個角色本來就不該拿到。

## D. 獨立性邊界（隔離規則沒有變）

| 角色 | 預設拿得到 | 一定拿不到 |
|---|---|---|
| `test-author` | behavior、契約、invariant、既有證據、測試慣例；範圍內有哪些檔 | **檔案內容與 implementation-detail 事實** |
| `impl-author` | 架構、契約、reuse、約定、要修的 finding 與沒過的閘 | 不相干模組的細節 |
| `plan-reviewer`／`verify-reviewer`／`finding-validator`／`final-audit` | 有 provenance 的架構／契約事實、diff、該軸 references | **作者辯護、其他 reviewer 的判定與 finding 結論** |
| `explore`／`plan`／`iteration-controller`／主線 | 該階段需要的事實；主線另外看得到「還擋著完工的」 | 品質結論型的「事實」（那種東西不存在） |

**fresh 不等於重學架構**：收尾稽核換一位獨立的 reviewer，是要它獨立下判定，不是要它把整個 repo 再摸一遍——它照樣重用有來源的架構事實。

## E. 來源變了怎麼辦（局部失效，不整包重建）

每次 build、iterate 或外部改動之後、派下一個 agent 之前，跑一次失效判定：

```bash
node <plugin-root>/scripts/knowledge-invalidation.mjs <loop 目錄> --root <repo 根> --revision <git sha> --apply
```

（不加 `--apply` 就是 dry-run，只印判定不寫回。）判準：

- 來源 digest 變了／來源不見了 ⇒ `invalid`（有正面證據）。
- code graph 換版或取不到 revision、執行證據的 revision 已經移動、本該查得到的來源查不到 ⇒ `uncertain`（證明不了仍有效）。
- 依賴剛被降級的上游 claim ⇒ 下游一律 `uncertain`，並傳到底。
- 其餘保持 `valid`——**這才是跨階段真正省下來的部分**。

判定結果 append 成 `knowledge.invalidated`，補查完 append `knowledge.refreshed`／新 claim。**歷史事件永不改寫**；刪掉 `.loops/.index/` 後由事件流重建，得到相同的有效記憶。

## F. 續作：只補差異

同一個 task／finding 的後續修正優先讓原 agent 續作；換人時給它 compact 的前次狀態（審過哪個 revision、讀過哪些 claim、哪幾條已失效、還有哪些沒答的問題）＋這次的 delta（fix、波及面、失效清單），**不重傳整段對話、也不重新探索沒被碰到的部分**。新風險、新模組或新契約才加派新的專家。

## G. 缺口怎麼講

pack 不夠用時，append 一筆 `context-gap.detected`，**指名缺什麼**（哪個檔、哪個 symbol、哪個契約）。不得以「先熟悉一下專案」為理由重跑完整架構探索——那正是這套機制要消除的成本。

## H. 誠實邊界

重用次數、pack 大小、重複來源宣告都只是**計數與估算**（`scripts/knowledge-metrics.mjs`）。**不得把「少查了幾次」乘上係數換算成「省了多少 token」**；節省量只能用同一組 corpus 的 baseline 與新流程實跑 A/B 比出來，runtime 取不到的一律標 `not_measured`。成本要改善，品質不得退步——兩件事要分開量、一起看。
