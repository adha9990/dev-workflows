// atomic-write.mjs —— loops-workflow Stop 家族共用的「整檔覆寫」原子寫入單一真相源（tmp+rename）。
//
// 背景（issue #183 T14/T15）：Stop 事件掛的多個 hook 會併發觸發（見 hooks.json）。其中多支
// （stop-gate / edit-accumulator / loop-driver）以整檔覆寫（非 append）的方式寫各自的 state 檔，
// 若直接 writeFileSync 目標路徑，reader 有機會讀到「寫到一半」的半截檔。loop-driver.mjs 早先已用
// tmp+rename（同目錄 rename 對 reader 是單一原子操作）解法；本檔把該寫法抽成共用小函式，供家族其餘
// 覆寫型寫檔重用，不再各自散抄一份（reuse-check）。
//
// ⚠️ 不適用 append-only 寫法：cost-tracker.mjs 用 appendFileSync 寫 costs.jsonl，語意是「逐行累積」
//   而非「整檔覆寫」，tmp+rename 不適用（且會與其 append 語意衝突），刻意不改。
//
// T15（Windows rename 失敗清殘檔）：renameSync 在 Windows 上可能因目標檔被佔用 / 唯讀而失敗
//   （EBUSY/EPERM 等）。失敗時清掉已寫出的 .tmp，避免留垃圾；清理本身失敗（.tmp 也被佔用）不得
//   冒泡——吞掉後仍拋出原始 rename 錯誤，交由呼叫端既有 fail-open 慣例處理（不讓「清理失敗」
//   意外改變呼叫端 hook 的決策輸出）。

import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

/**
 * 整檔原子覆寫：寫入同目錄的唯一 tmp 檔（含 pid + 時間戳 + 隨機片段，防同 pid 同毫秒內連續呼叫
 * 撞名），renameSync 蓋過目標路徑。reader 任何時刻讀到的都是「完整舊檔」或「完整新檔」，不會讀到
 * 半寫檔。renameSync 失敗時清掉 tmp（清理失敗吞掉，見檔頭 T15）後重新拋出原始錯誤。
 *
 * deps 是 rename/unlink 的注入點（port + injection，預設走真實 node:fs）：production 呼叫端一律用
 * 預設值，不需傳入；測試藉此在不依賴難以重現的真實 OS 競態下，直接驗證「rename 失敗 + cleanup 也
 * 失敗」這條路徑不會讓例外被 cleanup 的錯誤蓋掉、也不會多拋出東西。
 */
export function writeFileAtomic(filePath, content, encoding = 'utf8', deps = {}) {
  const rename = deps.rename ?? renameSync;
  const unlink = deps.unlink ?? unlinkSync;
  const dir = dirname(filePath);
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, content, encoding);
  try {
    rename(tmp, filePath);
  } catch (err) {
    try {
      unlink(tmp);
    } catch {
      // 清理失敗（.tmp 也被佔用等）不得冒泡改變呼叫端的決策輸出——吞掉。
    }
    throw err; // 原始 rename 失敗仍拋出，交由呼叫端既有 fail-open 慣例處理。
  }
}
