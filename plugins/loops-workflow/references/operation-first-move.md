# operation-first-move —— 依 operation 性質的 build 紅燈起手式（單一來源）

> **這是 operation 性質 × test-author 第一步規則的唯一定義處。** `skills/dispatch/SKILL.md`（寫 `operation` 欄）與 `skills/build/SKILL.md`（派 test-author 前讀 `operation`）都**引用此檔、不各自重述**。
>
> 與 loop.md 既有 `類型`（issue / design / fix）**正交**：`類型`決定起點 stage（fix 從 iterate 進、issue 從 goal 進）；`operation` 決定 **build 紅燈的第一步**。一個 issue 型 loop 仍要分它是 new-feature 還是 bug-fix。

## 為什麼要分

ECC 的 orch-* 對不同 operation 規定不同「第一步」：修 bug 不先寫**重現測試**，修完就無從證明真的修對；改既有行為不先更新 spec 測試，容易漏掉規格變更；重構若不先確認綠燈就動，分不清是重構引入的還是本來就壞。把性質傳進 build、讓 test-author 的紅燈起手式分岔，是低成本、直接提升「修對 / 改對」的成果正確性。

## 四性質 × 第一步規則

| operation | 何時用 | test-author 紅燈**第一步規則** |
|-----------|--------|------------------------------|
| `bug-fix` | 修正錯誤行為（issue 標 bug、或標題含 fix / 修 / regression / 壞 / 錯） | **第一個測試必須重現該 bug**——在套用修正**前**它要失敗、套用後轉綠。沒有這條「能複現的紅」就不算修 bug（區分「真修」與「順手改」）。 |
| `change-behavior` | 把既有功能改成**新規格**（行為要變） | 先把**既有相關測試更新到新規格**、讓它對舊實作失敗，再進 impl。防「改了行為卻沒更新對應 spec 測試」。 |
| `refactor` | 整理結構、**不改外部行為** | 動手前先確認既有測試**全綠**；無覆蓋的部分先補 **characterization test**（釘住現狀行為）才動。**本輪不寫新行為測試**——重構的紅綠是「行為不變仍綠」。 |
| `new-feature` | 新增功能（**也是 fail-safe 預設**） | 標準 TDD：為**新行為**寫失敗測試 → impl 轉綠。 |

## 判定準則 + fail-safe

- **Writer ＝ loop.md 的建立者**：`dispatch`（建 loop.md 時，§2——即使 `issue# → 從 goal 起`，dispatch 仍先建 loop.md 才進 goal，故由 dispatch 寫）或 `define`（無 issue 工作建 loop.md 時，§7）依 issue 性質寫入 `operation`。**依 issue 內容判定、非自動偵測程式**，是人/Claude 讀 issue 判。
- **goal 兜底**：goal step 1 讀 loop.md 時**若無 `operation` 欄**（任何成因——直接 `/goal` 未經 dispatch、define 漏寫、升級前舊 loop）就補寫，確保走到 build 前一定有著落。
- **讀取端 fail-safe（build）**：萬一 build 仍讀到**無 `operation` 欄** → 比照 fail-safe 視為 `new-feature`（標準 TDD），不停下。
- **fail-safe 向嚴**：性質拿不準（issue 同時像新增又像修、或描述不清）→ 用 `new-feature`（標準 TDD），並在 loop.md Journal 記一句「operation 不確定、暫定 new-feature」。理由＝漏掉「重現測試 / 更新 spec」比多寫一條失敗測試傷害大；標準 TDD 是最安全的下界。
- 一個 loop 只標**一個** operation（主要性質）。混合（既修 bug 又加功能）→ 拆 issue，或標主性質、在 Journal 註明次要面。

## 不變量（別誤改）

- 這條規則**只調整 test-author 的紅燈第一步**，不改「test-author 看不到 implementation」原則。bug-fix / change-behavior / new-feature 仍走標準 **Red→Green**；**唯 `refactor` 以「行為不變仍綠」取代紅燈相**——characterization test 本就全綠、無 Red，故 build step 2 對 refactor 確認「全綠」而非「確認 Red」（見 `skills/build/SKILL.md` step 2 的 refactor 例外）。
- 與 #8 verify 右尺寸化正交：#8 是「依改動性質調 verify reviewer 集」、本檔是「依 operation 性質調 build 紅燈起手式」，作用點不同。
