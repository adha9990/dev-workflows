# Refactoring（重構：異味 → 具名手法 → 設計模式）

> build 的 Refactor step（`impl-author`）+ `code-quality-reviewer` 用。分工：`code-simplification.md` 管「**怎麼安全地改、別過度簡化**」；這份管「**看到什麼該重構（異味）、用哪個具名手法改、何時才值得引入設計模式**」。重構 = 不改外部行為、只改內部結構（測試保護下）。

## 核心：先有異味才重構、先有綠燈才動手

重構不是「想到就改」。**觸發是 code smell**（具體的結構問題），**前提是綠燈測試**（行為不變的保證）。沒測試先補（見 `test-rubric.md`）；沒異味別亂動（Chesterton's Fence，見 `code-simplification.md`）。

## 一、常見 code smells（重構的觸發訊號，Fowler 分類）

- **臃腫 Bloaters**：Long Method、Large Class、Long Parameter List、**Primitive Obsession**（用原始型別表達領域概念）、Data Clumps（總是一起出現的欄位）。
- **濫用 OO**：條件 / switch 巨獸、Refused Bequest（繼承來的用不到）、Temporary Field。
- **改一處要改很多 Change Preventers**：Divergent Change（一個類因多種原因常改）、**Shotgun Surgery**（一個改動散到很多類）。
- **可有可無 Dispensables**：Duplicated Code、Dead Code、Speculative Generality（投機抽象）、用 Comments 當除臭劑掩蓋爛 code。
- **耦合 Couplers**：**Feature Envy**（方法過度用別的類的資料）、Inappropriate Intimacy、Message Chains（`a.b().c().d()`）、Middle Man。

## 二、具名手法（異味 → 對症的安全轉換）

| 異味 | 常用具名手法 |
|------|------|
| Long Method | Extract Function、Replace Temp with Query、Decompose Conditional |
| Long Parameter List / Data Clumps | Introduce Parameter Object、Preserve Whole Object |
| 條件 / switch + 型別分支 | **Replace Conditional with Polymorphism**、Replace Type Code with Subclasses |
| Duplicated Code | Extract Function、Pull Up Method、Form Template Method |
| Feature Envy | Move Function、Move Field |
| Primitive Obsession | Replace Primitive with Object、Introduce Value Object |
| Large Class | Extract Class、Extract Subclass |
| Message Chains | Hide Delegate、Extract Function |

每個手法：**小步、一次一個、每步跑測試**（安全紀律見 `code-simplification.md`：逐步改、Rule of 500、重構與功能分開 commit）。

## 三、重構時引入設計模式（目錄見 `design-patterns.md`）

某種異味**反覆出現**、且某個模式正好對症時，引入模式消除它（例：條件分支選演算法 → Strategy；流程骨架重複 → Template Method）。**完整模式目錄、各自對症時機與反面（pattern 上癮 / 過度設計）見 `references/design-patterns.md`** —— 紀律一致：**對症才用、不為套而套**。

## 紅旗

- 沒有對應的 code smell 就「順手重構」（製造風險 diff）。
- 沒有綠燈測試保護就動結構。
- 為了套設計模式而套（pattern 上癮 / 過度設計）。
- 一次塞多個手法進一個大 commit、難 review 難 revert。
- 把複雜度**搬家**（塞進別的 module / wrapper）而非真的消除。

## Verification

- [ ] 每次重構都對到一個具名 **code smell**（不是憑感覺改）。
- [ ] 動結構前測試是綠的、動完仍綠且**行為不變**。
- [ ] 用具名手法、小步、每步跑測試。
- [ ] 引入的設計模式有「反覆出現的異味」對症，不是投機 over-engineering。
- [ ] 重構 commit 與 feature / bugfix 分開。
