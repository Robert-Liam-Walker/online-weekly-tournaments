import { create } from "zustand";
import { User } from "../types";

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  clearAuth: () => void;
  isSubscribed: () => boolean;
}

// Minimal zustand store — add zustand to deps if using this
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem("foxtrot_token"),
  setAuth: (user, token) => {
    localStorage.setItem("foxtrot_token", token);
    set({ user, token });
  },
  clearAuth: () => {
    localStorage.removeItem("foxtrot_token");
    set({ user: null, token: null });
  },
  isSubscribed: () => get().user?.subscriptionStatus === "ACTIVE",
}));
