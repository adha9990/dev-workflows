# Fleet 競賽 / 投票式編隊

> **先分清楚**：loops-workflow 平常的多 agent 是**分工式並行**（explore 各查一角、verify 6 reviewer 各驗一軸、build 紅綠分離）—— 多 agent 各做**不同**子任務。**Fleet 不一樣**：多個 agent 跑**同一份**工作，再用投票 / 評審挑最好的。解空間很寬、單次嘗試品質不穩時才值得。

## 何時用 Fleet

- **plan 方案發想**：解法空間寬（例如「這功能架構怎麼設計」有多種合理走法）→ 派 N 個 agent 各從不同角度出方案（MVP-first / risk-first / user-first），再評審。
- **explore 難題**：同一個研究問題派 N 個不同檢索策略，攤開比較（但這偏分工，分工已夠用時不必 Fleet）。
- **build 卡關**：同一個任務兩三種實作走法都合理、難取捨 → 各做一版再比（成本高，少用）。

**不要**對「只有一個明顯正解」的工作用 Fleet —— 純浪費 token。

## 兩種挑選機制

### A. 評審團（judge panel）—— 適合方案類

```
1. 派 N 個 agent 各獨立產一個方案（prompt 給不同切入角度）。
2. 派 M 個 judge agent 各自獨立評分（用同一份評分軸：可行性 / 風險 / 對齊完工定義 / 可維護）。
3. 主線綜合：取總分最高的為主，把次高方案的好點子嫁接進來。
```

### B. 多數投票（majority vote）—— 適合判定類

```
1. 派 N 個 agent 對同一個是非題各自獨立判定（例：這個 finding 是真的嗎）。
2. 取多數。平手或分歧大 → 升級給使用者。
```

> verify 的 `finding-validator` 已是輕量版投票精神（二輪確認）；要更強可對關鍵 P0 finding 派 3 票對抗式驗證（多數駁回才殺）。

## 安全檢查表（派 Fleet 前過一遍，borrow orchestration-patterns）

1. 這幾個 agent 能同時跑、不打架（無共享可變狀態）。
2. 結果併回主線塞得下（context 預算）。
3. 評審 / 投票軸明確、各 judge 拿同一份。
4. 等待時間夠長、值得並行（不然序列更省）。
5. **同一個回合一次發出**才會真的並行；subagent 不能再派 subagent。

## 開法

opt-in：plan / explore 階段使用者說「這題用 Fleet 出 N 個方案評審」才啟動，預設不開（避免每個小決定都編隊、爆 token）。
