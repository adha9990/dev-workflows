#!/usr/bin/env node
// path-containment.mjs —— 詞法 containment 安全原語的單一真相源（#52 sandbox isolation）。
//
// eval 家族（eval-sandbox.checkContainment / eval-oracle.resolveWorkspace）共用同一條
// 「解析後路徑是否落在 root 內」判定，避免兩份各自演化出不一致的邊界語意。
// 純函式、無 IO、不 stat：呼叫端先把兩邊都 resolve 成絕對路徑，再交給本函式做詞法比對。

import { sep } from 'node:path';

/**
 * 已解析的 resolvedPath 是否落在 resolvedRoot 之內（root 自身或其子路徑）。
 * 用平台 sep 卡界線，避免共享前綴的兄弟目錄假命中（/root-evil 不算在 /root 內）。
 * @param {string} resolvedPath 已 resolve 的絕對路徑
 * @param {string} resolvedRoot 已 resolve 的絕對 root
 * @returns {boolean}
 */
export function isWithinRoot(resolvedPath, resolvedRoot) {
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
}
