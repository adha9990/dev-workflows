# auto 推進模式（opt-in Open Loop）

> **預設仍是 Closed Loop**（階段間都停）。`auto` 是**可選**模式：使用者**核准一次計畫**後，階段自動連跑、不再每階段停 —— 但**遇到危險或失敗仍會停**。這是「有保留驗證的折衷」—— 把確認 gate 收斂成一次（計畫拍板），但保留所有危險煞車。

## 怎麼開

- `dispatch auto <描述>` —— 整個 run 走 auto。
- 或在 `loop.md` 把 `推進模式` 設為 `auto`。
- 也可只對某段開：plan 拍板時說「接下來 build→verify 走 auto」。

## auto 模式做什麼

核准計畫後，主線自動依序跑 `build → verify → iterate`，**每階段照樣**：寫 `.loops/` 對應 markdown、分段 commit、紅綠分離、6 reviewer fan-out。只是**不在階段之間停下等人**。

## 但這些情況**一定停**（auto 的硬煞車）

不管 auto 與否，碰到就停下問人：

1. **危險 / 不可逆操作**：改權限、搬 / 刪資料庫、付款、刪資料、任何 `git revert` 救不回來的。
2. **測試怎樣都弄不綠**（超過 build 的修補上限）。
3. **規格 / 需求講不清楚**，需要使用者拍板才能往下。
4. **verify 判 `Not ready`** 且 iterate 回環**超過 3 圈**（接 iterate 的 3 圈上限）。
5. 任何 reviewer 報出 **P0**。

停下時在 `loop.md` 記一筆「auto 因 X 暫停」，等使用者處理後可續跑。

## 與 Closed Loop 的關係

| | Closed Loop（預設） | auto（opt-in） |
|---|---|---|
| 階段間 gate | 每段都停 | 不停（除上面硬煞車） |
| 核准點 | 每段一次 | **計畫拍板一次** |
| 安全停點 | 全部 | 危險 / 失敗 / P0 / 規格模糊 |
| 適用 | 預設、需要逐段把關 | 信任計畫、要一路跑完省來回 |

> 設計取捨：auto 不是「放生亂跑」，是「把確認 gate 收斂成一次（計畫拍板）+ 保留所有危險煞車」。預設關閉，使用者明確要才開。

> 要把 auto 接到排程 / 連續跑（環境的 `/loop`·`/schedule`），見 `references/automations.md`。
