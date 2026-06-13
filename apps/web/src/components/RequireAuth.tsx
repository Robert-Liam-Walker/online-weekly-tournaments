/**
 * RequireAuth — token gate for protected routes.
 *
 * PURPOSE
 *   Wraps any subtree that requires an authenticated session. On first render
 *   it checks whether the stored JWT is still valid; if not it redirects to
 *   /login, preserving the attempted location so Login can redirect back.
 *
 * PROPS
 *   children — the protected subtree to render once auth is confirmed.
 *
 * WHERE USED
 *   - App.tsx: wraps the entire "/*" catch-all route (all authed pages).
 *   - App.tsx Home: wraps Arena for the "/" route when a token is present.
 *
 * KEY BEHAVIOR
 *   1. No token → immediate <Navigate to="/login"> (no flash, no network call).
 *   2. Token present but no `user` in memory (page refresh / cold load):
 *      calls GET /auth/me to rehydrate the user object.
 *      - Success: calls setAuth(user, token) to populate the zustand store.
 *      - Failure: calls clearAuth() (removes token from localStorage) then
 *        the redirect in step 1 fires on the next render.
 *      While the /auth/me call is in-flight, renders null (blank screen) to
 *      avoid a flash of the protected content before auth is confirmed.
 *   3. Token present + user already in store → renders children immediately.
 *
 * NOTE: RequireAuth does NOT refresh expired tokens. A 401 from /auth/me
 * causes clearAuth() → redirect to /login. The axios interceptor in lib/api.ts
 * handles 401s from all other API calls the same way.
 */

import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuth";
import { api } from "../lib/api";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, user, setAuth, clearAuth } = useAuthStore();
  const location = useLocation();
  const [checking, setChecking] = useState(!!token && !user);

  // If we have a token but no user in memory (e.g. page refresh), verify it
  useEffect(() => {
    if (!token || user) {
      setChecking(false);
      return;
    }
    api
      .get("/auth/me")
      .then(({ data }) => {
        setAuth(data, token);
      })
      .catch(() => {
        clearAuth();
      })
      .finally(() => setChecking(false));
  }, []);

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (checking) {
    return null; // brief blank while validating token — avoids flash of content
  }

  return <>{children}</>;
}
