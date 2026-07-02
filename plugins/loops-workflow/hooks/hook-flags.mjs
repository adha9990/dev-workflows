// hook-flags.mjs —— loops-workflow 全部 opt-in/opt-out 環境旗標的單一真相源（issue #87「hook 預設值翻轉」）。
// 過去各 hook 各自散抄 `process.env.LOOPS_X === '1'`（optIn）或 `!== '0'`（defaultOn），語意分散、
// 容易漂移。本檔把「9 個 flag 各自屬於 defaultOn 還是 optIn」與「怎麼判斷開關」都收斂到這一處：
//   - FLAG_DEFAULTS：分類表（值即契約），逐 flag 標記 defaultOn: true/false。
//   - flagEnabled(name, env)：純函式，只吃傳入的 env 參數（不直接讀 process.env），方便測試與呼叫端
//     一致（呼叫端仍是 `flagEnabled('LOOPS_X', process.env)`）。
//
// #85 契約沿用（「只認字面值」）：
//   - defaultOn 類：未設 / 空字串 / 任何非 '0' 的怪值一律視為「開」，只有字面 '0' 才關閉。
//   - optIn 類：未設 / 空字串 / 任何非 '1' 的怪值一律視為「關」，只有字面 '1' 才開啟。
// 這樣「使用者手滑打錯值」永遠不會意外打開危險行為，也不會意外關掉安全防護。

// ── 對外契約：9 個 flag 的分類表（值即契約，逐欄釘死）─────────────────────────────
export const FLAG_DEFAULTS = {
  // defaultOn（6）：安全防護 / 觀測類，預設啟用，僅字面 '0' 可關閉。
  LOOPS_PATH_CONTAINMENT: { defaultOn: true },
  LOOPS_COST_TRACKER: { defaultOn: true },
  LOOPS_EVAL_GATE: { defaultOn: true },
  LOOPS_EVAL_TAGS_GATE: { defaultOn: true },
  LOOPS_EVAL_POLL_GATE: { defaultOn: true },
  LOOPS_CONFIG_PROTECTION: { defaultOn: true },
  // optIn（3）：會自動執行 repo 控制的命令 / 唯讀但涉及額外行為，預設關閉，僅字面 '1' 可開啟。
  LOOPS_STOP_GATE: { defaultOn: false },
  LOOPS_INSTINCT_INJECT: { defaultOn: false },
  LOOPS_COMPACT_HINT: { defaultOn: false },
};

/**
 * 判斷 flag 是否啟用：defaultOn 類僅字面 '0' 關，optIn 類僅字面 '1' 開，其餘（含未設/怪值）依分類。
 * 純函式：只讀傳入的 env 物件參數，不直接碰 process.env——讓呼叫端與測試都能注入可控輸入。
 */
export function flagEnabled(name, env) {
  const value = env?.[name];
  const defaultOn = FLAG_DEFAULTS[name]?.defaultOn ?? false;
  return defaultOn ? value !== '0' : value === '1';
}
