# friction-capture — 工作流摩擦回饋（自我改良迴圈）

> 對抗 **workflow knowledge loss（工作流知識流失）**：loops-workflow 還在實驗期，跑起來會踩到 plugin 自身的坑（階段指示不清 / hook 誤判 / reference 過時 / 得繞過限制 / docs 漂移）。踩過若沒回饋進 plugin，換 session 會重踩、同樣摩擦一再發生。friction-capture 把「踩到 ＋ 自己繞過」的經驗在 **loop 收尾一次批次回收**成「要不要寫進 plugin」的具體提案，讓工作流自己把踩過的坑補回自己身上（AGENTS.md 規則 13 + 規則 12 後失敗模式註）。

## 一、什麼算「可捕捉的摩擦」（只 plugin / 工作流、非 target bug）

- ✅ **算**：loops-workflow **本身**造成的阻力 —— 某階段 SKILL 指示不清 / 自相矛盾、hook 誤擋或誤放、reference 路徑或內容過時、AGENTS 規則與實際衝突、得繞過 plugin 的某限制才能推進、docs 與行為漂移、某流程步驟缺一塊你只好自己補。
- ❌ **不算**：**target 專案**的一次性問題 —— build 錯、環境雷、依賴衝突、該專案 code 的 bug。這些走 `iterate` 修；寫進 loops-workflow plugin 也防不了下次（不同專案不同坑）。
- **判準一句**：**「這個坑，改 loops-workflow 的某個檔能讓下次不再踩」才捕捉**；改不了 plugin 的不記。

## 二、當下怎麼記（不打斷流程、不當場問）

遇到並**自己繞過解決**時，**只在 `loop.md` Journal append 一行** `[friction]` 筆記（append-only、與既有 `E` 序號並存），**不當場停下分析、不當場派 agent、不當場問使用者** —— 省 context、不中斷 loop：

```
- [E<n>｜friction] 摩擦：<哪個階段 / hook / reference 怎麼卡> → 繞法：<你怎麼解的> → 疑似落點：<哪個 plugin 檔可能要改>
```

「疑似落點」允許留 `?`（收尾 agent 會補）。一條摩擦一行；不同摩擦分行記。

## 三、收尾批次處理（iterate §6，有筆記才做）

loop **完工 / 中止收尾**時，iterate grep Journal 的 `[friction]` 筆記：

- **無筆記** → 跳過、不派 agent、不問（絕大多數 loop 不觸發）。
- **有筆記** → 派**一個** subagent（背景、隔離 context —— 分析在它自己的 context 做、**不污染主 session**），塞給它：全部 `[friction]` 筆記原文 ＋ **本檔絕對路徑** ＋ 可讀的相關 plugin 檔。它的職責：
  1. 對每條 **root-cause**（真正的 plugin 缺陷在哪，不只症狀）。
  2. 對每條產**具體修改提案**：**哪個檔**（repo-relative 路徑）、**改什麼**（新增 / 修訂哪段，可附草擬文字）、**為什麼**（這樣改如何防再犯）、**風險 / 範圍**（docs-only／行為面）。
  3. **去重、合併**同源摩擦。
  4. **只提案、不動 plugin** —— 不編輯、不 commit、不 push 任何 plugin 檔（越權邊界，見下）。
  5. 把精煉提案清單當它的 **final message 回傳**，**然後結束**（agent 生命週期到此為止 —— 使用者原話「處理完再自己關掉」）。

## 四、主線接手 ＋ 詢問（agent 不能問使用者）

subagent 回傳後，**由主線（iterate）** 把提案濃縮呈現，用 `AskUserQuestion`（依 `comment-policy.md` 標推薦）問每案 / 整批**要不要寫進 plugin**：

- **「要」** → **由主 session 照既有 direct-edit plugin repo 紀律落地**（marketplace git 來源、先 `git status` 看 WIP、只 `git add` 己改檔、繁中 commit、push branch、開 draft PR、**merge 仍 human-gated**）—— **不在 friction-capture agent 內改**（agent 已結束）。**行為面大改**（hook 預設 / 刪功能 / 新 gate / security 面）仍照 AGENTS 規則停下確認、不逕自落地。
- **「不要 / 之後再說」** → 提案記 `loop.md` Journal 一行（留痕、不遺失），不動 plugin。

> **為什麼 agent 只分析、主線才問**：subagent **不能**對使用者發 `AskUserQuestion`（那是主迴圈與人互動的能力）。把「重的分析（讀 plugin 檔、擬 diff）」放 agent ＝隔離污染；把「輕的詢問 ＋ 落地」留主線 ＝符合工具能力邊界。淨效果仍是使用者原意：**分析隔離、被問到、agent 收工**。

## 五、Red Flags

- 把 **target 專案的一次性 bug** 當摩擦記進來（噪音；寫進 plugin 也防不了下次）。
- 摩擦**當下就停下**派 agent ＋ 問使用者（該只記一行、收尾再批次）。
- friction-capture agent **自己去改 / commit / push plugin**（只准提案，落地是主線的事）。
- 有 `[friction]` 筆記卻**收尾沒處理**（知識流失，正是本機制要防的）。
- 提案只有**症狀沒 root-cause**、或**沒指到具體 plugin 檔**（無法落地 ＝無效提案）。
