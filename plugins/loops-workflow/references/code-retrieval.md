# 統一 code 檢索（codebase-memory-mcp + staleness 紀律）

> loops 各階段 / 各 subagent 探索 code 的**單一正本方法**。原則：**graph 查穩定的既有 code（token 便宜）、改動的 code 一律讀實檔（防 stale）**。explore 與 verify reviewer 共用此正本——調整檢索策略只改這一處。

## 何時用 graph（repo 已索引且 ready）

先 `index_status` / `list_projects` 確認目標 repo 已索引且 ready（**worktree 內以主 checkout 路徑 / repo 身份判定、不是 worktree 絕對路徑** —— 對 worktree 目錄查會假陰性顯示未索引；未索引 → 見 §Fallback「預設先 index」）。是 → 用 codebase-memory-mcp 查**穩定的既有 code**（比 raw grep 省 token，經驗估算約 ~500t vs ~80K、未實測）：

| 需求 | 工具 |
|---|---|
| 找 function / class / route / 符號 | `search_graph`（name / label / qn pattern） |
| 呼叫鏈 / 資料流 / 跨服務 | `trace_path`（mode=calls \| data_flow \| cross_service） |
| 取某符號的確切 source | `get_code_snippet`（precise range） |
| graph-augmented 文字搜尋 | `search_code` |
| package / 分層 / cluster 全貌 | `get_architecture` |

## Staleness 鐵則（最重要 —— graph 是快照）

graph 是**索引當下的快照**。下列三類 code **很可能還沒進 graph，一律直接 Read / Grep 驗證、不可只信 graph**：

1. **worktree / 另一條 branch** 的 code
2. **未提交 / 剛改** 的 code
3. **`detect_changes` 列出的 changed_files**（＝你正在審 / 正在改的 diff）

流程：`index_status` → `detect_changes`（看自索引以來改了什麼）→ 上述三類讀實檔、其餘穩定碼才用 graph。

## 分支 / worktree 策略

loop 的 worktree 通常短命、diff 小：**複用既有 base 索引查穩定周邊 + `detect_changes` + diff 讀實檔**即可，**不需對每條 worktree / branch 重新 `index_repository`**（索引有成本，短命分支不划算）。

## Fallback

repo 未索引：
- **explore / 主迴圈：預設先用 codebase-memory-mcp 的 `index_repository` 對目標 repo 建索引、再用 graph 查** —— **不因「沒 index」就直接退 grep**（graph 的 token 效率與符號精度值回這一次索引成本）。**退 raw `Read` / `Grep` 只在明確例外**：① 只是定位 / 讀取單一或少數符號、**不需追呼叫鏈 / 依賴方向 / 架構**（graph 相對 grep 的優勢就在追鏈與結構;純定位 grep 一兩次就夠）；② repo 小到 grep 一兩次即覆蓋全部相關檔（單一目錄 / 模組）；③ mcp 不可用、或 `index_repository` 失敗；④ 使用者明示不要 index。
  - **「已有 base 索引」以主 repo 身份判定**：`index_status` / `list_projects` 比對**主 checkout 路徑**、不是 worktree 絕對路徑（worktree 是獨立目錄、對它查會顯示未索引 → 別誤觸對短命 worktree 重 index）。
  - **分工（三者不衝突）**：這裡的「先 index」指**完全沒 base 索引**的 repo；短命 worktree 已有主 repo base 索引 → 複用、不重 index（見〈分支 / worktree 策略〉）；repo 已索引但 `detect_changes` 顯示部分 stale → 那些 changed_files 讀實檔（見〈Staleness 鐵則〉）、不整體重 index。
- **verify reviewer：不自行索引**（reviewer 唯讀、不應有建索引 side-effect；通常已收改動檔清單 + 主迴圈 explore 建好的 base 圖）→ base 圖沒覆蓋的才 raw `Read` / `Grep` / `Glob`。**若上游未建 base 索引**（explore 被跳過、或退 grep 例外成立），reviewer 依舊不自索引、退 raw grep —— 繼承既有行為、非本次新增缺口。

## 誠實（省在哪）

省的是「**周邊 / 既有 code 的呼叫鏈與結構探索**」；**正在審 / 正在改的 diff 本身一定讀實檔**（correctness > token）。所以「追很廣」的探索（找所有 caller、查依賴方向、看架構、追 taint / 資料流）省最多。

## verify 情境範例

reviewer 收到：diff 的改動檔清單 + graph project id（若已索引）。做法：
- 改動檔（diff）→ 直接 `Read`（這是審查對象、且最可能 stale）。
- 「誰呼叫這個被改的函式 / 它依賴誰 / 落在哪層」→ `trace_path` / `search_graph` / `get_architecture` 查 graph（穩定周邊）。
- 動到的符號要看完整既有實作 → `get_code_snippet`。
