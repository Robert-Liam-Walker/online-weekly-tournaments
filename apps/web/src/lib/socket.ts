import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

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

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
