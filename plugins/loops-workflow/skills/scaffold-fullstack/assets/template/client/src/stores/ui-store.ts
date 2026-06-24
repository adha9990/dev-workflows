import { create } from 'zustand';

// Zustand 模式:每個關注點使用小而專注的 store(此處:UI chrome 狀態)。
// Server 狀態存放於 TanStack Query,而非此處 — 兩者保持分離。
interface UiState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
