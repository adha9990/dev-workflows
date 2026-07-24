#!/usr/bin/env node
// path-containment.mjs —— 詞法 containment 安全原語的單一真相源（#52 sandbox isolation）。
//
// eval 家族（eval-sandbox.checkContainment / eval-oracle.resolveWorkspace / baseline-corpus
// resolveWorkspace）共用同一條「解析後路徑是否落在 root 內」判定，避免各自演化出不一致的邊界語意。
// 純函式、無 IO、不 stat：呼叫端先把兩邊都 resolve 成絕對路徑，再交給本函式做詞法比對。

import { sep, isAbsolute, resolve } from 'node:path';

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

/**
 * 解析＋守門一步到位：requested（相對 baseDir）一律拒絕絕對路徑；解析後須落在 root 內，
 * 否則拒絕（不 spawn / 不讀取）。#169 baseline-corpus 與 #27 eval-oracle 各自的
 * 「isAbsolute 拒絕 → resolve → isWithinRoot → 組 reason」四步邏輯完全同構，抽成本函式共用
 * （eval-oracle.mjs 本體暫不改行為，僅留一行註記；#171 重整時一併收斂呼叫端）。
 * @param {string} requested 呼叫端收到的候選路徑字串（通常來自不受信的 fixture/task 檔）
 * @param {string} baseDir requested 的解析基準目錄（已是絕對路徑）
 * @param {string} root 信任邊界（已是絕對路徑），resolved 必須落在其內
 * @returns {{ok: boolean, resolved: string|null, reason: string|null}}
 */
export function resolveContainedPath(requested, baseDir, root) {
  if (typeof requested !== 'string' || isAbsolute(requested)) {
    return { ok: false, resolved: null, reason: `path "${requested}" 是絕對路徑（拒絕；須落在 root 內）` };
  }
  const resolved = resolve(baseDir, requested);
  if (!isWithinRoot(resolved, root)) {
    return { ok: false, resolved: null, reason: `path "${requested}" 解析後落在 root 外（路徑逃逸拒絕）` };
  }
  return { ok: true, resolved, reason: null };
}
