# loop: 243-show-subfolder-contents（eagle-app-core，摘錄／已重排格式，非逐字複製）

> 格式落差說明同 docs-rule-134-lessons-baked/observed-journal.md：真實 loop.md 用
> `[E1]`/`[E10]` 數字編號，stage 名不在方括號內；本檔重排成 parseStages 可辨識格式。
> 這條 loop 比 dev-workflows 自己的歷史 loop 舊、單 session、無 Agent Team 分工，
> 是本 corpus 裡規模最大的一條真實案例（60 個 sub-agent、2 圈 iterate 收斂）。
> 對應的精確 token/cost trace（非 stage 序列）另見 evals/baseline/traces/243-*.json
> （由 baseline-trace.mjs 從 eagle-app-core 的 .loops/.metrics/costs.jsonl 抽取，
> 與本檔案是兩份獨立產物：本檔驗證「走的階段對不對」，trace 驗證「花了多少」）。

## Journal

- E2 [goal] 逐句掃整張 issue 抽 requirement，寫六欄 DoD＋GWT 場景
- E3 [explore] 派 5 個平行 Explore agent 掃內部，收斂結論
- E4 [plan] 施工圖＋設計審查 3 圈收斂，乾淨無必修
- E6 [build] 14 任務全數紅→綠→commit，Checkpoint C 抓跨任務回歸
- E7 [verify] 部分，spend limit 中斷，findings 記錄
- E8 [verify] 完整續跑，8 reviewer 完成，Not Ready，13 blocking findings
- E9 [iterate] round 1 修 7 真缺口，round 2 delta re-verify 修 3 打磨，收斂 Ready
- E10 [iterate] 完工，draft PR #318（Closes #243）
