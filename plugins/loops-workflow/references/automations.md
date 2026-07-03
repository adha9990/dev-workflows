# Automations（排程 / 連續跑）

> loops-workflow 本身是互動式閉環。要「無人值守地推進」或「定期跑」，搭配環境內建的 `/loop` 與 `/schedule`，再用 `auto` 模式收斂 gate。**選用**。宿主環境沒有 `/loop`／`/schedule` 這類技能時本檔不適用——照常互動式跑迴圈即可，plugin 不自建排程 fallback。

## 1. `/loop` —— 自我推進到某條件

用環境的 `/loop` 讓某個 loops-workflow run 反覆推進，直到停止條件達成。搭 `auto` 模式（[`auto-mode.md`](auto-mode.md)）效果最好：`auto` 把階段 gate 收斂成一次拍板，`/loop` 負責一輪輪往下踩，危險 / 失敗 / P0 仍會停下等人。

適合：計畫已拍板、任務多、想讓它一路 build→verify→iterate 自己跑，你只在硬停點介入。

## 2. `/schedule` —— 定時觸發

用環境的 `/schedule` 排程定期動作，例如：

- 每天掃一次某 repo 的新 PR 回饋 → 起 `iterate`。
- 定期對某 branch 跑 `verify` 把關。

排程觸發的是「起一個 loops-workflow run」，不是繞過 gate；非互動情境下，遇到需要拍板的 gate 它會停下並回報，等你下次進來處理。

## 3. 安全邊界（不管怎麼自動，都守這些）

- **危險 / 不可逆操作一律停**（見 `auto-mode.md` 的硬煞車清單）。
- 回環 **3 圈上限**，超過 escalate。
- 每一步照樣寫 `.loops/` + 分段 commit + journal，留完整軌跡可回溯。

> 這層是把 loops-workflow 接到環境的排程 / 自跑能力，不是 plugin 自建排程器。plugin 只負責「被觸發後正確地跑一輪閉環」。
