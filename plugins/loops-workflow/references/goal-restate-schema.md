# goal restate 六欄 schema

> goal 階段產出 `00-goal.md` 的固定格式。六欄全部填實才算完工定義成立。欄名保留英文（跨階段一致），內容繁中。

## 模板

```markdown
# 完工定義 — <task-slug>

| 欄 | 內容 |
|------|------|
| Outcome | <做完後世界有什麼不同，一句話> |
| User | <誰受益、在什麼情境> |
| Why now | <為什麼現在做> |
| Success | <可驗證的成功訊號＝停止條件，要能被客觀檢查> |
| Constraint | <邊界 / 不可違反的限制> |
| Out of scope | <明確不做什麼，防範圍蔓延> |

## 訪談軌跡（HYPOTHESIS + CONFIDENCE）

- <問題 1>｜HYPOTHESIS: <當時的猜測>｜CONFIDENCE: <0–100>｜使用者答：<答案>
- <問題 2>｜HYPOTHESIS: <…>｜CONFIDENCE: <…>｜使用者答：<…>
- …

## 停止條件

<把 Success 欄展開成一條條可勾選的驗收，verify 階段會逐句對照>
- [ ] <條件 1>
- [ ] <條件 2>
```

## 填寫守則

- **Success 必須可驗證**：寫「上傳 10MB 圖片 3 秒內出縮圖」，不寫「縮圖體驗變好」。
- **Out of scope 不可空**：想不到要排除什麼，代表訪談還沒夠深。
- HYPOTHESIS + CONFIDENCE 是訪談留痕：每問記下當時猜測與把握，優先打 confidence 最低、影響最大的點。
- 95% 信心就停止訪談；restate 要拿到使用者**明確 yes**（「你決定」不算）。
