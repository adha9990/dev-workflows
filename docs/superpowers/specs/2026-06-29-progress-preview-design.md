# 設計：以 `/progress` + `PROGRESS.md` 取代 statusline

> 狀態：草案（待使用者過目）｜日期：2026-06-29｜範圍：`plugins/loops-workflow` + 根 `README.md`

## 1. 問題與目標

loops-workflow 目前查看 loop 進度有三條路：statusline（底部一行 `⟳ <slug> · <stage>`）、`/loops-workflow:status`（列 active loops）、SessionStart hook（開場浮出）。其中 **statusline 是主力但不好用**：

- **資訊量極低**：只有 `slug · stage`，看不到第幾圈 / 哪個任務 / findings / gate / Journal / 下一步。
- **要安裝又要重開 session 才生效**，依賴 claude-hud，bash wrapper 在 Windows 有路徑/shell 眉角。
- **固定一行、無法展開**，只顯示一個 loop。

資料其實夠豐富（`loop.md` 的 Journal + `0N-*.md`），痛點是 statusline 這個**出口太窄**。

**目標**：用一個共用 renderer、兩個高資訊量出口取代 statusline——
1. on-demand 的 `/loops-workflow:progress [slug]`：在 chat 印完整儀表板。
2. 自動保持最新的 `.loops/<slug>/PROGRESS.md`：在編輯器 markdown preview 常駐看。

**非目標**：不改 `.loops/` 的資料模型（`loop.md` / `0N-*.md` / Journal 格式不動）；不重構 `session-start.mjs`（其特徵測試所釘字串不動，僅標註可日後共用新 lib）；不動 `status`（保留為「列全部」，與 `progress`「深看一個」分工）。

## 2. 決策摘要（使用者已拍板）

| 決策 | 選擇 |
|---|---|
| 進度預覽形式 | `/progress` 指令 + `PROGRESS.md`，共用一個 renderer |
| PROGRESS.md 刷新 | **Stop hook 自動渲染**（零 token、不改 skill、恆跑、永不擋路） |
| statusline 去留 | **完全移除** |
| README 幅度 | **全面重構** |
| 工作位置 / 交付 | `Documents/GitHub/dev-workflows` clone → branch `progress-preview` → PR → squash merge |

## 3. 架構

```
loop.md + 0N-*.md
   │
   ▼
scripts/loops-scan.mjs        ← 共用：掃 .loops/（含 worktree）+ 解析 loop.md 欄位
   │                            （自被刪的 hud-status.mjs 救出，純函式 + 守衛 + 永不丟）
   ▼
scripts/progress.mjs          ← 共用 renderer：抽結構 → 渲染兩種出口
   ├─────────────────────────────┬───────────────────────────────
   ▼                             ▼
commands/progress.md          hooks/progress-render.mjs
= node progress.mjs [slug]    = Stop hook（恆跑），每回合 node progress.mjs --write-only
  印 chat 儀表板到 stdout        只重生本 session active loop 的 PROGRESS.md
  + 寫 PROGRESS.md               不印 stdout、不注入 context、exit 0
```

一個 renderer、兩個消費者。零 token（純 node）、跨平台（不靠 bash wrapper / claude-hud）、免安裝（hook 隨 plugin 生效）。

## 4. 元件

### 新增

| 檔 | 角色 |
|---|---|
| `scripts/loops-scan.mjs` | 共用 `.loops/`（含 `.claude/worktrees/*/.loops/`）掃描 + `loop.md` 欄位/Journal 解析。`export` 純函式（`collectLoopEntries(cwd)`、`pickLoopField(md,label)`、`lastJournalLine(md)`、`journalLines(md)` 等），仿 `session-start.mjs` 的「純函式 + IO 薄邊界 + `import.meta.url` 守衛」分層。 |
| `scripts/progress.mjs` | renderer。輸入一個 loop（slug 或 session active），抽結構 → ① 印 chat 儀表板到 stdout ② 寫 `PROGRESS.md`。`--write-only` 只做 ②。無 `.loops/` / 找不到 loop → no-op exit 0。任何錯誤吞掉 exit 0。 |
| `scripts/test-progress.mjs` | 用 fixture 驗渲染，沿用既有 `test-*.mjs` 風格（直接 import 純函式 + 跑 `--write-only` 驗檔內容）。 |
| `commands/progress.md` | `/loops-workflow:progress [slug]` 薄指令：定位並跑 `progress.mjs`、relay 輸出、提示可開 `PROGRESS.md` 看 markdown preview。 |
| `hooks/progress-render.mjs` | Stop hook（恆跑）：對本 session active loop 跑等同 `progress.mjs --write-only` 的渲染；永不擋路 exit 0、不注入 context。 |

### 刪除

`scripts/statusline.sh`、`scripts/hud-status.mjs`、`commands/install-statusline.md`

### 修改

| 檔 | 改什麼 |
|---|---|
| `hooks/hooks.json` | Stop 陣列加 `progress-render.mjs`；更新 `description`。 |
| `README.md` | §8 全面重構（見 §8）。 |
| `AGENTS.md` | 規則 3「供 statusline / resume」→「供 progress / resume」；規則 9 掃描說明；§3 intent 表「想裝 statusline」列 → 「看進度 `/progress`」。 |
| `docs/FLOW.md` | §9 automations 列（statusline HUD → progress）；§10 數字（command 清單 `install-statusline`→`progress`、hook 數 +1 並改述）。 |
| `references/automations.md` | statusline HUD 段 → progress 段（若有提及）。 |

## 5. 資料流與抽取規則（全部 deterministic，抓不到一律省略、不編造）

- **階段管線**：固定順序 `goal → explore → plan → build → verify → iterate`；前置 `clarify / scaffold / define` 僅當 Journal/檔案有跡象才顯示。`當前階段` ＝ `●`、其前 `✓`、其後 `○`；`當前階段=完工` → 全綠。
- **圈數**：數 Journal 中「回環 #N」最大 N → `圈 N/3`（上限常數 3，與 iterate 一致）。無回環 → `圈 0/3` 或省略。
- **findings / HEAD**：抓最後一筆含 `findings X→Y` / commit SHA 的 Journal 行；無 → 省略該欄。
- **當前任務 / 下一步**：當前任務 best-effort 從 `03-build.md` 任務列或最後 build 相關 Journal 抓；下一步用階段順序映射。抓不到只顯示階段。
- **最近 Journal**：末 3–5 筆。
- **完工**：顯示末尾 `★[outcome]` 度量行（若有）。
- **選哪個 loop**：指令給 slug 用該 slug；未給 → 本 session（`CLAUDE_CODE_SESSION_ID` 比對 `loop.md` 的 `session` 欄）的 active loop，退化成最近活躍（mtime）。hook 一律本 session、找不到就 no-op。

## 6. 兩個出口長相

### chat（`/loops-workflow:progress`）

```
⟳ 137-trash-delete-permanent   issue·bug-fix·auto   圈 1/3
goal ✓  explore ✓  plan ✓ │ build ● │ verify ○  iterate ○
任務 3/4  DELETE /api/trash/:id   紅✓ 綠✓ refactor中   HEAD a1b2c3d
findings 1→0
最近：E4 plan拍板 / E5 build任務1綠 / E6 回環#1 verify P1→回build
下一步 → build 任務4 → verify
```

### `.loops/<slug>/PROGRESS.md`（自動產、gitignored）

頂端註明「由 loops-workflow 自動產生、請勿手改」。內容：標題行（slug / 類型 / operation / 模式 / 圈數 / 停止條件）+ mermaid 階段流程圖（done/now 上色）+ 階段 checkbox（當前標「← 現在」）+ 當前任務/findings/HEAD 區 + Journal 時間軸表（最近數筆）+ 下一步。完工則全綠 + outcome 行。

## 7. 錯誤處理與邊界

- renderer 與 hook **任何錯誤一律吞掉 exit 0**（仿 `session-start.mjs`：純函式無 IO，`main()` IO 邊界 try/catch，`import.meta.url` 守衛使被 import 時不執行）。
- `PROGRESS.md` 一律寫進**主 repo 的 `.loops/`**（loop.md 所在的根），**不寫進 worktree**（守 `AGENTS.md` 規則 9，避免被 `git clean` / `worktree remove` 連坐刪除）。
- hook **不注入任何 context**（避免每回合洗版 / 吃 token），只做檔案 side-effect。
- `PROGRESS.md` 受既有 `.loops/*` gitignore 涵蓋、不入庫。

## 8. README 全面重構大綱

- 頂層精簡：marketplace 一句話 + 安裝；點出唯一 pipeline 入口 `/loops-workflow:dispatch`。
- 三層資訊架構：①marketplace/安裝 ②**loops-workflow**（工作流程 + skill 清單 + 兩引擎 + 進階）③**scaffold-fullstack**。
- 將整段「statusline 進度（HUD）安裝」換成「**進度預覽（`/progress` + `PROGRESS.md`）**」：說明 chat 儀表板 + markdown preview 兩種看法、免安裝、跨平台、零 token。
- 更新「進階(opt-in)」表的進度列、「結構」樹（scripts 去 `hud-status`/`statusline` 加 `progress`+`loops-scan`；commands 去 `install-statusline` 加 `progress`；hooks 加 `progress-render`）。

## 9. 測試（`scripts/test-progress.mjs`）

fixtures + 斷言：
1. build 階段中的 loop → 階段管線正確（plan✓ build● verify○）、圈數正確、`PROGRESS.md` 含 mermaid + checkbox + 當前任務。
2. 完工 loop → 全綠 + outcome 行。
3. 無 `.loops/` → no-op、不丟、無輸出。
4. `--write-only` → 不印 stdout、只寫檔。
5. 缺欄位（無 findings / 無回環）→ 對應欄省略、不編造。

## 10. 交付

`Documents/GitHub/dev-workflows` clone（`core.longpaths=true`）→ branch `progress-preview` → 實作 → push → 開 PR（使用者 review 後 **squash merge**）。本 spec 先 commit 進此 branch。

## 11. 待實作時再定的小細節（不阻擋拍板）

- `commands/progress.md` 定位 `progress.mjs` 路徑的方式（沿用 `install-statusline.md` 搜 `plugins/**/loops-workflow/scripts/` 的模式，優先 marketplaces）。
- mermaid 在 PROGRESS.md 的精確 classDef 配色。
- `progress.mjs` 與 `loops-scan.mjs` 的拆分邊界（哪些純函式歸 scan、哪些歸 render）。
