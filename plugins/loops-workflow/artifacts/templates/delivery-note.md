<!-- loops-artifact: delivery-note@1 -->
# delivery-note — <slug> 交付說明

> **`direct` 檔位的完工交接物**（`references/stages/effort-profile.md` §C）：把 `explain` / `checklist` / `cost` 三份合成一份。
> 縮的是**份數**，不是內容——為一個兩檔五十行的改動生三份文件，其中兩份會是「無」。
> 三段都要真的寫得出來；**寫不出「實作導讀」代表沒人讀得懂這次改動，那這條 loop 本來就不該是 `direct`**。
> `standard` / `deep` 檔位不用這一份，照舊產 `explain.md` ＋ `checklist.md` ＋ `cost.md` 三份。

## 實作導讀

改了什麼、為什麼這樣改、進入點在哪（`file:line`）。三到五句，寫給**沒參與這次改動的人**看。

## 合併前手動驗證

只有人親手驗得了的項目（互動、版面、a11y、外部整合）。**沒有這類項目就寫「無，證據是 `<指名的既有測試 / gate>`」**——留白和「沒有」分不出來。

| # | 驗什麼 | 怎麼驗（可照做的步驟） | 預期結果 | 驗過了？ |
|---|---|---|---|---|

## 成本輪廓

依 `references/shared/runtime/journaling.md`〈完工 outcome 度量〉的欄位寫成一行：投入檔位（含升檔次數）｜token 粗估（標 `est`）｜sub-agent 數｜回環圈數｜findings 確認→剩餘｜交付物。**量不到的欄位標 `not_measured`，不補一個看起來合理的值。**
