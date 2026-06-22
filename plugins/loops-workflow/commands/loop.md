---
description: 開一個 loops-workflow 閉環（決策樹分流到對的起點階段）。等同 dispatch。
argument-hint: [一句話描述 / issue# / PR#，可加 auto]
---

使用 `loops-workflow:dispatch` skill，對以下輸入做決策樹分流、建 `.loops/<slug>/loop.md`、停在起點 gate（不自動往下；除非輸入含 `auto`，見 references/auto-mode.md）：

$ARGUMENTS
