---
description: 列出目前所有 active 的 loops-workflow 迴圈（讀 .loops/，唯讀）。
---

掃描當前工作目錄的 `.loops/` **以及 `.claude/worktrees/*/.loops/`**（worktree 裡跑的迴圈 —— 在主 repo 開的 session 也列得出底下 worktree 的進度），列出每個迴圈的：**slug / 類型 / 當前階段 / 推進模式 / 最後一筆 Journal 事件**（可標出在哪個 worktree）。若都沒有或為空，回報「目前沒有 active 迴圈」。**不改任何檔**。
