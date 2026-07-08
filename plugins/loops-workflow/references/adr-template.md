# ADR 模板（含 Consequences）

> plan 階段記錄設計決策用，存進 `stages/02-plan.md`。重點是 **Alternatives Considered**（每個候選的 pros/cons + 為什麼被否決）與 **Consequences**（決策的後果，含負面）。
>
> **用途區分**：本模板＝**獨立 ADR 檔**用；plan 內嵌的決策留痕表＝`design-plan-schema.md` §6 欄位集（選擇 / 為什麼 / 背書 / 未採用 / 拍板人），兩者用途不同、不可混用。

## 模板

```markdown
## ADR-<N>：<決策標題>

### Context
<為什麼要做這個決策；當下的限制、需求、既有狀態>

### Decision
<決定採用什麼；一句話講清楚>

### Alternatives Considered
| 候選 | Pros | Cons | 結果 |
|------|------|------|------|
| <候選 A（採用）> | <…> | <…> | ✅ 採用 |
| <候選 B> | <…> | <…> | ❌ 否決：<理由> |
| <候選 C> | <…> | <…> | ❌ 否決：<理由> |

### Consequences
- **正面**：<這個決策帶來什麼好處>
- **負面 / 代價**：<要承受什麼、放棄了什麼、未來可能的債>
- **後續影響**：<會牽動哪些其他決策 / 模組>
```

## 填寫守則

- **Alternatives 至少列到真正比較過的選項**；只有一個選項代表沒做選擇，不是 ADR。
- 涉及取捨的決策用 `AskUserQuestion` 拍板（每選項標推薦 + 理由），結果回填這張表。
- **Consequences 必須寫負面**：只寫好處的 ADR 是行銷文，不是決策紀錄。
- 若決策是「引入新套件」，Alternatives = ≥3 候選比較表（掃現有 deps → 列候選 → 比較 → 拍板）。
