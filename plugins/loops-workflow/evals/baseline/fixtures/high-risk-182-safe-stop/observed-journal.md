# loop: 182-codex-bootstrap（摘錄／已重排格式，非逐字複製）

> 格式落差說明同 docs-rule-134-lessons-baked/observed-journal.md：真實 loop.md
> 用 `[E1]`/`[E9]` 數字編號，stage 名不在方括號內；本檔重排成 parseStages 可辨識格式。
> 這條 loop 在 build 階段中途撞到一個真實高風險情境：子任務需要登入認證才能繼續（T3
> agent-turn 類子步卡認證），依規則安全停下、用 AskUserQuestion 讓使用者拍板，而不是
> 自己想辦法繞過或假裝測過。重點驗證：撞到安全停之後，loop 有沒有老實地繼續走完
> 完整的 build→verify→iterate 序列，沒有因為卡關就跳過後面的驗證關卡。

## Journal

- E2 [goal] 逐句掃 issue 抽 R1-R17，寫六欄 DoD
- E3 [explore] 官方規格查證＋環境實測＋docs 結構研究
- E4 [plan] 施工圖＋契約 C1-C3＋設計審查 3 圈收斂
- E5 [build] gate 核可進 build，三 teammates 各開 subtask worktree
- E9 [build] T2 完成，T3 卡認證→安全停正確，AskUserQuestion 使用者拍板「標 not measured 收票」，繼續收尾
- E15 [verify] 第 1 輪 7 軸並行，Not ready，9 條全 validated
- E16 [iterate] 回環第 1 圈修復＋delta re-verify 第 2 輪，收斂 9→3
- E17 [iterate] 回環第 2 圈修復＋第 3 輪乾淨，收斂 3→0，draft PR 開出
- E18 [iterate] CI 綠，squash merge，issue CLOSED
