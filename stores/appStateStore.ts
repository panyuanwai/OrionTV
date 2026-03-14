import { create } from "zustand";

interface AppStateStore {
  resumedFromBackground: boolean;
  markResumedFromBackground: () => void;
  consumeResumedFromBackground: () => boolean;
  clearResumedFromBackground: () => void;
}

export const useAppStateStore = create<AppStateStore>((set, get) => ({
  resumedFromBackground: false,
  markResumedFromBackground: () => set({ resumedFromBackground: true }),
  consumeResumedFromBackground: () => {
    const value = get().resumedFromBackground;
    if (value) {
      set({ resumedFromBackground: false });
    }
    return value;
  },
  clearResumedFromBackground: () => set({ resumedFromBackground: false }),
}));
