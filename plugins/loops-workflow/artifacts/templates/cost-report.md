# cost — <slug> 成本歸因

> 這份檔由 `scripts/cost-report.mjs` 從 `.loops/<slug>/telemetry/events.jsonl` **完全生成**（deterministic）。
> 手改沒有意義：下次 render 會蓋掉。要改內容就補事件，不要改這份檔。
> 同一份 ledger 重複 render，以下每個 section 必須逐位元組相同。

## Measurement Status

哪些數字是量到的、哪些沒量到。**沒量到就寫 `not_measured`，不補一個看起來合理的值。**

| 維度 | 狀態 | 依據 |
|---|---|---|

## Executive Summary

這條 loop 一共花了多少、花在哪、最值得注意的一件事。

| 項目 | 值 |
|---|---|

## By Phase

逐 phase 拆解。**`iterate` 不會出現在這張表**——它是 iteration-controller（控制節點），不是工作階段。

| Phase | Turns | Input | Output | Cache write | Cache read | Duration | USD | 狀態 |
|---|---|---|---|---|---|---|---|---|

## Control Overhead

控制節點（dispatch 路由、iteration-controller 回環決策）本身的成本——不屬於任何 phase 的那部分。

| 控制節點 | Turns | Input | Output | Cache write | Cache read | Duration | USD | 狀態 |
|---|---|---|---|---|---|---|---|---|

## By Iteration

`iteration=0` 是初次實作；verify 出 finding、進 remediation／reverify 才遞增。

| Iteration | 觸發原因 | Turns | Input | Output | Cache write | Cache read | Duration | USD | 狀態 |
|---|---|---|---|---|---|---|---|---|---|

## By Activity

同一個 phase 裡不同動作的成本差異（review 跟 remediate 是兩回事）。

| Activity | Turns | Input | Output | Cache write | Cache read | Duration | USD | 狀態 |
|---|---|---|---|---|---|---|---|---|

## Agent & Task Detail

每個 agent 逐一列出。**不得出現 `other-subagent`**；還原不出身分時寫 `unattributed:<runtime-id>` 並在最後一欄寫明缺了哪個 event。

| Agent | Role | Task | Iteration | Phase / Activity | Turns | Input | Output | Cache write | Cache read | Duration | USD | 狀態 | Findings |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Tool / Context Footprint

工具用了幾次、搬了多少位元組。**tool 的 bytes 不是 token**——context token 欄一律標 estimated。

| Tool | 次數 | 用途 | Input bytes | Output bytes | Duration | Context tokens（estimated） |
|---|---|---|---|---|---|---|

## Quality Yield

發出來的 finding 有多少真的被確認、被修掉。emitted 很多但 validated／resolved 很少，代表驗證在空轉。

| 指標 | 數量 |
|---|---|

## Artifact & Delivery Footprint

產了哪些人類可見產物、驗證過沒有、送出去了沒有。

| Artifact | 版本 | 產生於 | 驗證 | 發布 |
|---|---|---|---|---|

## Hotspots and Recommendations

只寫追得到 ledger 證據的項目。沒有量到的一律寫 `not_measured`，不推測。

| # | 現象 | 證據 | 建議 |
|---|---|---|---|
