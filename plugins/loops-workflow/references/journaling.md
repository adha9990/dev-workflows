# 跨 session resume / journaling

> `.loops/<slug>/loop.md` 不只是儀表板，還是**可續跑的事件日誌**。把每個重要動作 append 進去，新 session 只要讀它就能重建狀態、接著跑 —— 不靠對話記憶。

## loop.md 的 journal 區段

在 `loop.md` 末尾維護一個 **append-only** 的事件日誌（只加不改、保留順序）：

```markdown
## Journal（append-only）

- [E1] 進入 explore：讀 00-goal.md，派 Explore 掃 codebase
- [E2] gate：explore→plan，使用者選「方案 B（擴充既有 SearchService）」
- [E3] 進入 plan：拆 4 任務，ADR-1 記選型
- [E4] gate：plan→build 拍板
- [E5] 進入 build：任務 1 Red→Green→commit a1b2c3d
- [E6] 回環 #1：verify 報 P1（缺 owner 過濾）→ 回 build
- ...
```

事件用**序號**（E1, E2…）排序，不用時間戳（跨工具 / 跨 session 時間不可靠）。每筆一行：**動作 + 結果 / 產物（commit SHA、選擇、回環）**。

## Resume 協定（新 session 接手）

任一階段被獨立呼叫、或新 session 要續跑：

1. **先讀 `loop.md`**：看 `當前階段`、`停止條件`、`Journal` 最後幾筆。
2. **重建狀態**：當前在哪一階段、上一個 gate 通過了沒、回環第幾圈、哪些 `.loops/NN-*.md` 已產出。
3. **回報使用者**：「這個 loop 停在 `<階段>` 的 `<gate>`，已完成 E1–En，接下來是 X，要續跑嗎？」
4. 續跑後**繼續 append** 新事件，不覆蓋舊的。

## 與 auto 模式的關係

auto 模式（[[auto-mode]]）暫停時，journal 記「auto 因 X 暫停於 E_n」；resume 時從該點接續，不重跑已完成的階段。

## 為什麼 append-only

- 保留完整決策軌跡（誰在哪個 gate 選了什麼、為什麼回環）—— 事後可稽核、可回溯。
- 不覆蓋 = 不會因為改寫遺失「為什麼走到這」。
- 與 Anthropic 官方「plan → validate → execute」可被腳本檢查的計畫檔精神一致（見 [[plan-schema]]）。
