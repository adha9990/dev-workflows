# loop: 902-canonical-fixture-malformed-journal（T31 contract-test fixture，負向案例：Journal 條目格式壞掉）

- 類型：issue
- 起點階段：goal
- 當前階段：build
- session：sess-def456
- 推進模式：closed
- 停止條件雛形：功能可用、既有測試綠、無 P0/P1 未解

## Journal（append-only）

- E1 [goal] 正常一筆，格式合規
- 沒有序號也沒有方括號 stage 標記的一筆亂寫，格式不合規
