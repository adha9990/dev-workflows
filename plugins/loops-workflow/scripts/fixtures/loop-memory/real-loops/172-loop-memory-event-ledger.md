# loop：172-loop-memory-event-ledger

> feat(loop-memory)：event ledger＋SQLite work graph 重構 .loops 記憶體

| 欄位 | 值 |
|---|---|
| **類型** | issue ｜ **operation** `new-feature` |
| **issue** | [#172](https://github.com/adha9990/dev-workflows/issues/172)（parent #168；依賴 #170 registries ✅、#171 resolver contract ✅） |
| **當前階段** | build |
| **推進模式** | auto（跳過 verify；本 repo 已無 CI；本機測試掃描暫停至全部 issue 完成） |
| **base** | master @ 8fd120c |

## 可行性實測（開工前）

| 項目 | 結果 |
|---|---|
| `node:sqlite`（不新增套件的前提） | ✅ Node 24 內建可用 |
| FTS5 全文檢索 | ✅ 可建虛擬表、可跑 match |
| issue 點名的 `.loops/243-show-subfolder-contents` | ❌ 不存在為活 loop；其 **trace** 在 `evals/baseline/traces/243-show-subfolder-contents.json`——遷移驗證以該 trace 為素材 |
| 「Journal 無界成長」是否為真 | ✅ 現場實證：`.loops/183-*/loop.md` 已 95 行且仍在增長 |

## Journal

- [E1] dispatch → 可行性實測（見上表）。三個既有 loop（170／171／183）＋一份 trace 是遷移驗證素材。
- [E2] goal ＋ plan 寫完（S1–S9 停止條件、10 個任務），`validate-plan.mjs` 通過（依賴無環、verification 齊全）。
- [E3] 派出三軸設計審查（opus）：事件流與可重建性／context pack 與索引降級／遷移與相容性爆炸半徑。
- [E4] Lead 自查三項（先於審查回報）：①`--filter/--min-cases` 非本 repo 慣例（53 支測試皆不吃參數）→ 已從計畫 9 處移除、重驗通過；②`loop.md`／`PROGRESS.md` 命中 **55 個檔**，爆炸半徑遠大於計畫預估；③`progress.mjs:extractProgress` 的 `round`／`findings`／`head` 是掃**整份** Journal 得來（`findLast`／`reduce`），Journal 一旦截到最近 N 筆，`回環 #N` 捲出視窗就會**靜默倒退成 0**——而 characterization fixture 是 `圈 0/3`，抓不到這個回歸。
- [E5] Lead 補查事實：`.loops/*` 已被 gitignore（只 re-include `gate.config.json`）⇒ `events.jsonl` **不入版控**，遷移產物不會出現在 PR diff，S9 的證據必須是**可重跑的腳本**而非committed artifact；`.loops/` 不得寫進 worktree 已由 `hooks/loops-path-guard.mjs` 機械化（既有資產，非本票新建）。
- [E6] Lead 最大發現：**Journal 現在就是事件流，只是以散文形式存在 markdown 裡**。`references/shared/runtime/journaling.md`（146 行、canonical 單一來源）開宗明義寫「`loop.md` 不只是儀表板，還是可續跑的事件日誌」；`skills/{dispatch,goal,iterate}`、`references/{personas,shared/runtime,stages}`、`docs/FLOW.md`、`AGENTS.md` 共 **10 個檔 29 處**散文在指示「append 一筆 Journal 到 loop.md」。⇒ `loop.md` 一旦改為生成物，這 29 處指示全部變成「寫進一個會被覆寫的檔」，而**沒有任何檢查抓得到散文過期**。本票必須把 authoring 介面從「手寫 Journal 行」改成「append 一筆事件」，並改寫 `journaling.md` 為 ledger 的 canonical 文件。
- [E7] 設計審查三軸回報，共 **17 條 must-fix**，全數採納並折回計畫（任務 10 → **16**）。**Lead 自己被打臉一條**：E4① 錯誤——`--filter`／`--min-cases` **是**既有慣例（4 支測試實作、地板未達成真的 exit 1、出處是 #170「10 個任務共用一條指令無法證明該任務的測試存在」），已改回並補上前綴撞號修正（實測 `--filter T1` 會跑到 16 個 case，把 T10+ 算進來）。
- [E8] 三個「本來就已經壞掉」的既有解析器被審查挖出：`baseline-trace` 的 session 抽取對四條真檔**全 null**（它要冒號、真檔是豎線）；`eval-trajectory` 抽出的階段序列是垃圾（`["e1","e2",…]`）；`test-canonical-contracts` 的 schema **對四條真檔全判不合格**（缺欄 4/4、違規 3–27 條）而它 30/30 恆綠——因為只跑自造 fixture＝自我印證。⇒ repo 內同時存在**四種互斥的 loop.md 形狀契約**，本票必須指名一種、其餘三種逐一處置（決策 7）。
- [E9] 三個假綠陷阱被實測戳破：①「逐位元相同」擋不住 3 行的「整份塞 payload」遷移器（170/171/183 **3/3 全綠**，語意理解為零）⇒ 改三道可證偽斷言；②`PRAGMA integrity_check` 對 schema 改壞／FTS drop／資料語意錯**全回 ok**⇒ 改 ledger head 指紋；③FTS5 預設 tokenizer 把整串中文當單一 term，健康索引下 `MATCH '索引'` 就回 **0 筆** ⇒「壞掉」與「健康」回傳相同，天生假綠。
- [E10] `hooks/loops-path-guard.mjs` 只掛編輯工具：**Bash payload 靜默放行、node 直接 `fs.writeFileSync` 寫進 worktree `.loops` 完全成功**，且 `.gitignore` 讓違規對 git 隱形、`loops-scan.mjs` 反而把它當合法 loop 掃出來。而本票的遷移器正是一支 node 腳本 ⇒ S9 目前是零保證的慣例，新增 T9 腳本層 containment。
- [E11] 第三軸（事件流）回報，**又推翻我一條計畫內容**：T1 原本寫「重用既有的原子寫入葉節點」是**錯的**——`hooks/atomic-write.mjs` 第 9–10 行**自己就明文排除 append 語意**，套上去會變成每筆事件重寫整檔（O(n²)）。repo 早有 4 個 `appendFileSync(JSON + '\n')` 站點，照慣例寫即可。
- [E12] 三個計畫層的內在矛盾被挖出並修正：①**E3「不整份放棄」與 C5「不得靜默不完整」互斥**——第 500 行壞掉時照 E3 字面跳過續讀，重建出中間有洞的狀態，正是 C5 要防的形狀 ⇒ 改「停在該行、前綴仍可用」；②**降級階梯斷底**——決策 3 說「索引壞掉改 replay」，但 E2 讓 replay 遇未知版本直接失敗 ⇒ replay 之下沒有下一層，C3「不影響 audit trail」是空頭支票。回退一版 plugin 就會讓那條 loop 永久磚化、連卡在哪都看不到 ⇒ 拆 `replayExact()`／`replayPrefix()`；③**`seq` 沒有配號者**——Stop 家族掛 4+ 併發 hook，而實測 8 行程並發 append 完全不撕裂＝多寫者物理可行 ⇒ 明訂 seq 只保證單調不減、**排序權威是檔案行序**。
- [E13] 「逐位元」的真相：happy path **確實逐位元相同**（獨立複驗兩次），但三種無害變異會炸——schema 加 `DEFAULT CURRENT_TIMESTAMP` 差 208 bytes；逐筆 autocommit 併成單一交易差 2 bytes（offset 27／95＝change counter）；全新建檔 vs 原地 `DELETE`＋重插差 **5.7 倍**（12288 vs 69632，freelist 不還 OS）。⇒ **SQLite 位元是「寫入交易次數」的函數，不是「邏輯狀態」的函數**，教科書等級的 change-detector test。改 W2a 邏輯轉儲／W2b 純文字快照才逐位元。
- [E14] `events.jsonl` 的成長界線原本一個字都沒寫，而 repo 另外三份 jsonl 都有 1000 行 cap、且用的是自承「**非原子 read→rewrite**」的輪替——照抄會把中段損壞從「實測 0 次」變成「必然發生」，而 E1 只檢查尾行完全偵測不到 ⇒ 明訂 **事件流永不輪替**並禁止照抄。
