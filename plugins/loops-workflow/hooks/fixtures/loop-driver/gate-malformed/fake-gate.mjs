#!/usr/bin/env node
// fake-gate.mjs —— cq-F4 fixture：模擬 gate 腳本本身壞掉、吐非 JSON 垃圾輸出（非某一道 gate 紅，而是
// 整支 gate 腳本的結果解析不了）。用於測試 loop-driver.mjs 的 LOOPS_LOOP_DRIVER_GATE_SCRIPT 覆寫：
// main() 呼叫此腳本取代預設 loops-quality-gate.mjs，JSON.parse 應失敗 → fail-open（不 block、不收攤 state）。
// 忽略任何傳入參數，永遠印一段非法 JSON 並以 exit 0 結束（模擬「看起來跑完了但輸出解不了」的情境）。
process.stdout.write('THIS IS NOT JSON <<<garbled output>>> {{{ not-parseable');
process.exit(0);
