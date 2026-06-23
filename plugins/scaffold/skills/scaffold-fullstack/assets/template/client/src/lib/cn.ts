import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// 慣用的 className 組合器:clsx 處理條件式 class,twMerge 則解決
// 衝突的 Tailwind utility(後者勝出)。每個 UI 元件都會用到。
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
