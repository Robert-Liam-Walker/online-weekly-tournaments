/**
 * socket.ts — Socket.io client singleton for the FoxTrot web app.
 *
 * PURPOSE
 *   Creates and caches a single Socket.io connection so all hooks and
 *   components share the same socket rather than opening multiple connections.
 *
 * CONNECTION URL LOGIC
 * ──────────────────────────────────────────────────────────────────────────
 *   The socket server is co-hosted with the REST API on the same Node process.
 *
 *   VITE_SOCKET_URL unset (production + local dev):
 *     Connects to window.location.origin (same host/port as the SPA).
 *     - Dev: Vite proxies /socket.io to :3001.
 *     - Production: the ALB routes /socket.io to the API target group.
 *
 *   VITE_SOCKET_URL set (staging or cross-origin deploys):
 *     Connects to the provided URL directly. Set this when the socket host
 *     differs from the SPA origin (e.g. separate EB environment).
 *
 * AUTHENTICATION
 *   The JWT is passed in the socket handshake `auth` object
 *   ({ token: "<jwt>" }). The server's socket middleware validates this token
 *   and attaches the user to the socket session.
 *   Note: the token is read from localStorage at connection time. If the user
 *   logs out and back in, call disconnectSocket() + getSocket() to reconnect
 *   with the new token.
 *
 * EXPORTS
 * ──────────────────────────────────────────────────────────────────────────
 *   getSocket() → Socket
 *     Returns the shared Socket instance, creating it on first call.
 *     Subsequent calls return the cached socket without reconnecting.
 *
 *   disconnectSocket()
 *     Disconnects and nulls out the cached socket. Call this on logout to
 *     ensure the next getSocket() reconnects with a fresh token.
 */

import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * Return the shared Socket.io connection, creating it on first call.
 * Reads the JWT from localStorage at connection time for the handshake.
 */
export function getSocket(): Socket {
  if (!socket) {
    const token = localStorage.getItem("foxtrot_token");
    // Socket.io shares the API's port. Default to same-origin (prod: ALB
    // routes /socket.io to the API; dev: Vite proxies it to :3001) —
    // VITE_SOCKET_URL only needs to be set when the socket host differs.
    socket = io(import.meta.env.VITE_SOCKET_URL ?? window.location.origin, {
      auth: { token },
    });
  }
  return socket;
}

/**
 * Disconnect and clear the cached socket.
 * Call on logout so the next getSocket() creates a fresh authenticated
 * connection with the new (or absent) token.
 */
export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
