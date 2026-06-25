// model 層彙整出口。viewmodels 從這裡取領域型別 / 純邏輯 / api 端點。
// (View 層不可 import model —— 由 ESLint zone 強制,一律經 viewmodels。)
export * from './types';
export * as api from './api';
