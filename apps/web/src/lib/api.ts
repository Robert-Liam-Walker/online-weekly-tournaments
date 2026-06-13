/**
 * api.ts — shared Axios instance for all FoxTrot API calls.
 *
 * BASE URL LOGIC
 * ──────────────────────────────────────────────────────────────────────────
 *   Production / local dev (same-origin):
 *     VITE_API_URL is unset → baseURL = "/api"
 *     Vite dev server proxies /api → http://localhost:3001/api.
 *     In production, the ALB routes /api/* to the Express backend.
 *
 *   Staging (different-origin S3 + Elastic Beanstalk):
 *     VITE_API_URL = "https://api.staging.example.com" (no trailing slash)
 *     → baseURL = "https://api.staging.example.com/api"
 *     Trailing slashes on VITE_API_URL are stripped to avoid double-slash.
 *
 * REQUEST INTERCEPTOR — JWT injection
 *   Reads "foxtrot_token" from localStorage on every request and attaches it
 *   as "Authorization: Bearer <token>". Reading from localStorage (rather
 *   than the zustand store) avoids a circular import with useAuth.ts.
 *
 * RESPONSE INTERCEPTOR — 401 handling
 *   On any 401 response:
 *     1. Removes "foxtrot_token" from localStorage.
 *     2. Hard-redirects to /login (window.location.href) — skipped if already
 *        on /login to avoid redirect loops.
 *   This mirrors clearAuth() in useAuth.ts but is intentionally separate to
 *   avoid importing the zustand store here (would create a circular dep and
 *   make the axios instance harder to test in isolation).
 *
 * NOTE: The zustand store's `token` field is initialized from localStorage on
 * store creation, so clearing localStorage here will desync the in-memory
 * store until the next page load. That is acceptable — the hard redirect
 * causes a full page reload which re-initializes the store to null.
 */

import axios from "axios";

// Same-origin "/api" by default (dev: Vite proxy; prod-ALB: path routing).
// Staging serves the SPA from S3 with the API on a different origin (EB), so
// VITE_API_URL can point at that origin and "/api" is appended to it.
const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "");

export const api = axios.create({
  baseURL: apiOrigin ? `${apiOrigin}/api` : "/api",
});

/** Attach the JWT from localStorage as a Bearer token on every request. */
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("foxtrot_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * On 401: evict the token and redirect to /login.
 * All other errors are re-rejected as-is for callers to handle.
 */
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("foxtrot_token");
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);
