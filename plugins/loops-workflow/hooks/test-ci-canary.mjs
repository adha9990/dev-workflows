#!/usr/bin/env node
// 臨時 canary（#129 T3 驗證用、將 revert）：故意紅，證明 CI 管道有牙＋glob 抓到未列舉新檔。
console.error('✗ ci-canary：故意失敗（驗證 CI 紅燈，將 revert）');
process.exit(1);
