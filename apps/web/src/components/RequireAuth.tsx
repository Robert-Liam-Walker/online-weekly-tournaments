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
