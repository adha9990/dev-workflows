# 程式碼簡化（code-simplification）

> build 的 Refactor step 與 code-quality-reviewer 的可讀性 checklist。核心：簡化的目標不是更少行，是更好讀。

## 核心原則

簡化的目標**不是更少行**，是「更好讀、更好懂、更好改、更好 debug」。每個簡化都要過一個測試：**「新進同事看這版會比原版更快看懂嗎？」** 不會，就別改。

## 一、Chesterton's Fence —— 改 / 刪前先答這五問

看到一道你不懂為什麼存在的籬笆，別急著拆。先弄懂原因，再決定原因還在不在。動任何既有 code 前，答得出：

1. 這段 code 的**責任**是什麼？
2. 誰**呼叫**它？它呼叫什麼？
3. **邊界 / 錯誤路徑**有哪些？
4. 有沒有**測試**定義了它的預期行為？
5. 當初**為什麼這樣寫**（效能？平台限制？歷史原因）？查 `git blame` 看原始 context。

答不出來 → 你還沒準備好簡化，先去讀更多 context。

## 二、過度簡化四陷阱（簡化的失敗模式）

- **內聯過頭**：刪掉一個「給概念命名」的 helper，呼叫點反而更難讀。
- **硬合併不相關邏輯**：兩個簡單函式併成一個複雜函式，不是更簡單。
- **刪掉「多餘」的抽象**：有些抽象是為了可擴展 / 可測試而存在，不是複雜度。
- **為行數最佳化**：少行不是目標，好懂才是。

## 三、簡化流程

1. **逐步改**：一次一個簡化，每步跑測試。pass → 繼續 / commit；fail → revert 重想。
2. **重構與功能分開**：refactor 的 commit 不混進 feature / bugfix。混在一起的 diff 難 review、難 revert。
3. **Rule of 500**：若一次重構要動 > 500 行，投資自動化（codemod / AST transform），別手改 —— 手改易錯又難 review。
4. **收斂在改動範圍**：預設只簡化「本次改到的 code」，不順手 refactor 無關的東西（製造雜訊 diff + regression 風險）。

## 四、清晰優先於精巧（反例）

```typescript
// 不清楚：密集三元鏈
const label = isNew ? 'New' : isUpdated ? 'Updated' : isArchived ? 'Archived' : 'Active';

// 清楚：可讀的對應
function getStatusLabel(item: Item): string {
  if (item.isNew) return 'New';
  if (item.isUpdated) return 'Updated';
  if (item.isArchived) return 'Archived';
  return 'Active';
}
```

註解原則見 `clean-code.md`〈六、註解講 why 不講 what〉（本體）；例：解釋「**what**」的（`// increment counter` 配 `count++`）刪掉，解釋「**why**」的（`// 因為 API 高負載下會抖，所以重試`）保留。

## 五、Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「能跑就別動」 | 難讀的 code 壞掉時更難修。現在簡化，省的是未來每次改動的時間。 |
| 「少行一定更簡單」 | 一行巢狀三元不比五行 if/else 簡單。簡單是「看懂的速度」，不是行數。 |
| 「順手把這段無關的也簡化」 | 越界簡化＝雜訊 diff + 你沒打算改的 code 也可能 regression。 |
| 「型別會自我說明」 | 型別說明結構，不說明意圖。好的命名解釋 why，型別只解釋 what。 |
| 「這抽象以後可能有用」 | 見 `clean-code.md` 紅旗「投機抽象」條——沒價值的複雜度，要時再加。 |
| 「原作者一定有理由」 | 也許。查 `git blame`、套 Chesterton's Fence。但累積的複雜度常常沒理由，只是壓力下迭代的殘渣。 |

## 六、Red Flags

- **簡化需要改 test 才能過 → 你改的是行為，不是結構，停下。**（build Refactor step 的硬紅旗）
- 「簡化」後反而更長、更難跟。
- **把複雜度搬家而非減少**：簡化只是把複雜塞進別的 module / 新 wrapper / 共用層（搬走、總量沒少）—— 那不是簡化，是把複雜度藏起來。
- 為了個人偏好改命名，而非對齊專案慣例。
- 為了「更乾淨」刪掉錯誤處理。
- 簡化你還沒完全看懂的 code。
- 一堆簡化塞進一個大而難 review 的 commit。

## 七、Verification

- [ ] 所有既有測試**未經修改**仍通過。
- [ ] build 成功、無新警告；linter / formatter 過。
- [ ] 每個簡化都是可獨立 review 的增量改動。
- [ ] diff 乾淨，沒混入無關改動。
- [ ] 簡化後對齊專案慣例（對照 CLAUDE.md）。
- [ ] 沒有移除 / 弱化任何錯誤處理；沒留 dead code。
