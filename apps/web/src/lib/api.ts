import axios from "axios";

// Same-origin "/api" by default (dev: Vite proxy; prod-ALB: path routing).
// Staging serves the SPA from S3 with the API on a different origin (EB), so
// VITE_API_URL can point at that origin and "/api" is appended to it.
const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "");

export const api = axios.create({
  baseURL: apiOrigin ? `${apiOrigin}/api` : "/api",
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("foxtrot_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

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
