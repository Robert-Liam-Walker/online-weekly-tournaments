/**
 * main.tsx — application entry point.
 *
 * Bootstraps the React tree: mounts <App /> inside React.StrictMode onto the
 * #root element in index.html. StrictMode enables extra development-time
 * checks (double-invoking effects, deprecated API warnings, etc.) and has no
 * effect in production builds.
 *
 * index.css is imported here so Tailwind's base/components/utilities layers
 * are injected once at the top of the bundle.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
