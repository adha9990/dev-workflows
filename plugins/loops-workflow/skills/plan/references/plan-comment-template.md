# plan-comment-template — 完整版 plan 對齊 comment 樣板

> loops-workflow `plan` 階段 post 到 issue 的對齊 comment **一律用此完整格式**（取代舊版 terse）。
> 含：系統全貌 + 套件清單 + ADR + 機制圖（mermaid）+ 施工圖 + 契約規格 + **成果展示** + out-of-scope。
> GitHub 原生渲染 ` ```mermaid ` 區塊，所以機制圖**直接放進 comment**（不再只躺在 `02-plan.md`）。
> 流程：寫 tmp 草稿 → 校稿 → `gh issue comment <#> --body-file <tmp>`（或更新既有用 `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<tmp>`）→ 刪 tmp。
> 這份 comment 是 **living as-built 摘要**：build 偏離 plan 時回來同步更新（含已 post 的版本）。

---

## 樣板（填空，刪掉用不到的列；機制圖至少畫關鍵的 1–2 個）

```markdown
## 📐 實作對齊（plan 階段）— <feature 名稱>

> loops-workflow plan gate 對齊留痕。本 comment = **as-built 計畫摘要**（living，設計決策變動才更新）；**self-contained，不連 `.loops/` 路徑**（那是本地暫存、不上 GitHub）。<承接的研究/issue>

---

### 🧭 系統全貌
<一段：要做什麼、核心手法、明確不做什麼。若有正交軸/相位切分，在此點出。>

---

### 📦 套件清單（本票新增，裝進 <where>）
| 套件 | 版本 | 用途 |
|------|------|------|
| `<pkg>` | `<ver>` | <用途> |
> <型別/build/baseline 等零依賴做法的補充；為何不引某依賴。>
> **不寫安裝進度欄**（已裝/待裝是 session 進度，不進 comment）。

---

### 🧱 系統決策（ADR）
| # | 決策 | 選項 | 結論 | 理由 |
|---|------|------|------|------|
| 0 | <最關鍵的，如 branch-base/排程> | <opts> | **<結論>** | <理由> |
| 1 | <路線/套件選型> | <opts> | **<結論>** | <理由> |
| … | | | | |
> <跨層後果/零改動點等補充。>

---

### ⚙️ 機制圖
**機制 A — <名稱>（運作流程）**
` ```mermaid ` … ` ``` `

**機制 B — <名稱>（注入 / 接線）**
` ```mermaid ` … ` ``` `

---

### 🗺️ 施工圖（檔案落點 + 任務相位）
| 檔案 | 動作 | 職責 |
|------|------|------|
| `<path>` | 建/改 | <職責> |

**任務相位**：<Phase 1 / Phase 2 或 task 清單，標 base / 相依——**不寫 session 進度**>

---

### 📜 契約規格（跨 API/資料模型/事件才寫）
- **資料模型**：<schema + 約束 + migration 可逆性>
- **HTTP/事件**：<request/response/錯誤形狀；重用或新增>
- **測試層**：<每條契約對到哪層測試>

---

### 🎯 成果展示（before → after · 使用者可感價值 · 如何驗收）
| 情境 | before | after |
|------|--------|-------|
| <關鍵情境> | <現在> | <完工後> |

- **使用者可感價值**：<做完後使用者的體感 / 行為差別，用使用者語言、非技術描述>
- **驗收 demo**：<怎麼實地跑一遍看到它生效（步驟 + 觀察點）>
> 純內部重構（無使用者可感差別）→ 改放「行為對照（前 → 後）」+ 怎麼驗證等價；**此段一律必填、不可省**。

---

### 🚫 Out of scope
<明確不做，防範圍蔓延。>
```

---

## 撰寫紀律

- **機制圖一定進 comment**：每個關鍵機制畫「運作流程」+「注入/接線」兩張 mermaid，直接貼進 comment（GitHub 會渲染）。這同時滿足「拍板前把機制圖渲染給使用者看」。
- **成果展示為必含區塊、不可省 / 不可裁**：對齊 comment 一律「**完整施工圖 ＋ 成果展示** 並存」——施工圖講「怎麼做」（系統全貌 / ADR / 機制圖 / 施工圖 / 契約），成果展示講「做完使用者看到什麼」（before→after / 使用者可感價值 / 怎麼 demo 驗收）。**不要把 comment 裁成只有成果、丟掉施工圖；也不要有施工圖卻漏掉成果展示。** 位置放在契約之後、Out of scope 之前（施工細節之後、收束之前）。<br>（#188 實測教訓：曾依「成果導向」誤把 comment 裁成 outcome-only、丟掉施工圖；改回完整版後又漏了成果展示、需手補——兩個方向都是錯，此區塊的存在就是把兩者鎖成並存。）
- **套件清單必列版本 + 狀態**：已裝標實際版本；待裝標 ⏳ 並在 ADR 說明為何選它（≥3 候選比較的細節留本地過程，**comment 直接放結論、不外連 `.loops/`**）。
- **絕不引用 `.loops/` 路徑**：comment 上 GitHub，`.loops/`（`02-plan.md`…）不上 GitHub 且 PR merge/close 後清除 → 指它＝死連結。內容 self-contained；要指更細只指 PR/commit/`file:line`/issue（見 `references/comment-policy.md §0`）。
- **ADR 表含「最關鍵決策放第 0 列」**：排程/branch-base/相依這種會卡整盤的先講。
- **mermaid 安全**：node 標籤用雙引號包；避免裸 `{{ }}`（用「變數佔位」描述）、避免標籤內未引號的 `()` `/` `:`。
- **不記 session/cycle 進度**：comment 是**計畫 / 設計對齊**，**不寫「目前跑到第幾個 cycle / 哪些已完成 / 套件裝了沒」**這種 ephemeral 進度 —— 那是 `.loops/<slug>/03-build.md` 的事。讀者看 comment 是要懂「設計怎麼長」，不是追工程進度。
- **保持 living（僅指設計）**：**設計決策變 / 任務拆法變** → 回來 PATCH 這則 comment 與 `02-plan.md` 維持 as-built；但「living」**不等於**把它當進度板更新。
