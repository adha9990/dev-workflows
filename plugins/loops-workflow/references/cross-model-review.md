# cross-model-review —— 跨模型二審（換一個模型當對手）

> iterate / verify 用（opt-in）：同一個模型開再多 fresh context，也共享同一套盲點。當迴圈**卡住**或改動**blast radius 大**時，換一個**不同的模型 / CLI** 當對手 reviewer，抓出同模型結構性看不到的問題。
>
> 這是 loops-workflow 唯一沒有原生對應的 doubt-driven 機制 —— verify 的 6 reviewer、finding-validator、referee 全是**同模型** fresh context；真正不同的模型才補得了這個洞。

## 何時觸發（要先問使用者，預設不開）

- iterate 回環**逼近 3 圈上限**、findings 仍沒收斂 → 在「3 圈 escalate」這個點，把跨模型二審當**選項**提給使用者。
- 高 blast radius 決策（改共用元件 / 契約 / 核心演算法 / 安全關鍵路徑）。
- 使用者主動說「換個模型再審一次」。

**貴 + 要外部 CLI**，所以預設關閉、由使用者點開。**auto / 非互動模式直接跳過**（明說跳過，不靜默 fallback）。符合 `AGENTS.md` 規則 10 成本意識：只在真的值得時才燒這筆。

## 怎麼跑（唯讀、不偏袒、不靜默）

1. 把要審的 **artifact + 契約 + 一句「找問題、預設挑剔」** 寫進 prompt 檔 —— **不夾作者 rationale**（同 verify 反偏見規則：餵理由會讓對手偏向同意）。
2. 用環境可用的**另一個模型 / CLI**，prompt 由 stdin / `--prompt-file` 餵入，跑在**唯讀 sandbox**，不准改檔。
3. 跑不起來 / 環境沒有別的 model → **明說「跳過跨模型二審（無可用的他模型）」**，不假裝跑過、不靜默 fallback 回同模型。

## 怎麼用結果

- 跨模型 finding 一樣過 `finding-validation.md` 二輪（是否真實 / 本次引入 / 已防護 / 對症）—— 不因為「別的模型說的」就免驗。
- **同模型沒看到、跨模型抓到的** → 盲點佐證，優先看。
- 兩個模型都指同一方向 → 強佐證，信心加分。
