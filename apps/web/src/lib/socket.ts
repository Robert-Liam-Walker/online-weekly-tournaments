import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const token = localStorage.getItem("foxtrot_token");
    socket = io(import.meta.env.VITE_SOCKET_URL ?? "http://localhost:3002", {
      auth: { token },
    });
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
