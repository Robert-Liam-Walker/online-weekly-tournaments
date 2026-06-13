/**
 * useAuth.ts — Zustand auth store for the FoxTrot web app.
 *
 * STORE SHAPE (AuthState)
 * ──────────────────────────────────────────────────────────────────────────
 *   user: User | null
 *     The currently authenticated user object (id, username, email,
 *     subscriptionStatus, subscriptionEndsAt?, role?). Null before login or
 *     after clearAuth(). Populated by setAuth() or by RequireAuth calling
 *     GET /auth/me on page refresh.
 *
 *   token: string | null
 *     The JWT for the current session. Initialized from localStorage on
 *     store creation so it survives page reloads. Null after clearAuth().
 *
 * ACTIONS
 * ──────────────────────────────────────────────────────────────────────────
 *   setAuth(user, token)
 *     Persists the token to localStorage["foxtrot_token"] and updates
 *     both `user` and `token` in the store. Called on successful login and
 *     on token rehydration (RequireAuth → /auth/me response).
 *
 *   clearAuth()
 *     Removes the token from localStorage["foxtrot_token"] and sets both
 *     `user` and `token` to null. Called on logout (Nav Sign-out button)
 *     and on 401 responses (via the axios interceptor in lib/api.ts).
 *
 *   isSubscribed() → boolean
 *     Derived selector: returns true when user.subscriptionStatus === "ACTIVE".
 *     Convenience for feature gates; safe to call when user is null (returns
 *     false).
 *
 * PERSISTENCE
 *   Only the raw JWT string is persisted (localStorage["foxtrot_token"]).
 *   The user object is re-fetched from /auth/me on cold load by RequireAuth;
 *   it is never written to localStorage.
 *
 * USAGE
 *   import { useAuthStore } from "./hooks/useAuth";
 *   const { user, token, setAuth, clearAuth, isSubscribed } = useAuthStore();
 *   // or with a selector to avoid over-rendering:
 *   const token = useAuthStore((s) => s.token);
 */

import { create } from "zustand";
import { User } from "../types";

interface AuthState {
  /** Currently authenticated user; null when logged out. */
  user: User | null;
  /** JWT for the current session; initialized from localStorage on load. */
  token: string | null;
  /**
   * Persist the JWT and populate the user object in the store.
   * Called after a successful login or /auth/me rehydration.
   */
  setAuth: (user: User, token: string) => void;
  /**
   * Remove the JWT from localStorage and clear user + token from the store.
   * Called on logout or when the API returns a 401.
   */
  clearAuth: () => void;
  /** Returns true when the current user has an ACTIVE subscription. */
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
