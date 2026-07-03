# 統一 code 檢索（codebase-memory-mcp + staleness 紀律）

> loops 各階段 / 各 subagent 探索 code 的**單一正本方法**。原則：**graph 查穩定的既有 code（token 便宜）、改動的 code 一律讀實檔（防 stale）**。explore 與 verify reviewer 共用此正本——調整檢索策略只改這一處。

## 何時用 graph（repo 已索引且 ready）

先 `index_status` / `list_projects` 確認目標 repo 已索引且 ready。是 → 用 codebase-memory-mcp 查**穩定的既有 code**（比 raw grep 省 token，經驗估算約 ~500t vs ~80K、未實測）：

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

repo 未索引 / mcp 不可用：
- **explore / 主迴圈**：值得用 graph（大 repo、會反覆探索）→ 可先用 codebase-memory-mcp 的 `index_repository` 對目標 repo 建索引後再查，或派內建 `Explore` agent；不值得就 raw `Read` / `Grep`。
- **verify reviewer**：**不自行索引**（reviewer 唯讀），直接 raw `Read` / `Grep` / `Glob`。

## 誠實（省在哪）

省的是「**周邊 / 既有 code 的呼叫鏈與結構探索**」；**正在審 / 正在改的 diff 本身一定讀實檔**（correctness > token）。所以「追很廣」的探索（找所有 caller、查依賴方向、看架構、追 taint / 資料流）省最多。

## verify 情境範例

reviewer 收到：diff 的改動檔清單 + graph project id（若已索引）。做法：
- 改動檔（diff）→ 直接 `Read`（這是審查對象、且最可能 stale）。
- 「誰呼叫這個被改的函式 / 它依賴誰 / 落在哪層」→ `trace_path` / `search_graph` / `get_architecture` 查 graph（穩定周邊）。
- 動到的符號要看完整既有實作 → `get_code_snippet`。
