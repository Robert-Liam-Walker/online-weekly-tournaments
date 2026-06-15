import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { useAuthStore } from "../hooks/useAuth";

interface ChatMessage {
  id: string;
  channel: string;
  userId: string;
  content: string;
  createdAt: string;
  user: { id: string; username: string };
}

const CHANNEL = "main";

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function Feed() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: history = [] } = useQuery<ChatMessage[]>({
    queryKey: ["chat", CHANNEL],
    queryFn: () => api.get(`/chat/${CHANNEL}`).then((r) => r.data),
  });

  // Join channel and listen for new messages
  useEffect(() => {
    const socket = getSocket();
    socket.emit("chat:join", { channel: CHANNEL });

    socket.on("chat:message", (msg: ChatMessage) => {
      if (msg.channel !== CHANNEL) return;
      queryClient.setQueryData(["chat", CHANNEL], (old: ChatMessage[] = []) => {
        // Avoid duplicates if REST already returned it
        if (old.some((m) => m.id === msg.id)) return old;
        return [...old, msg];
      });
    });

    return () => { socket.off("chat:message"); };
  }, [queryClient]);

  // Scroll to bottom when messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);

  function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed) return;
    getSocket().emit("chat:message", { channel: CHANNEL, content: trimmed });
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 flex flex-col" style={{ height: "calc(100vh - 120px)" }}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-gray-500 text-lg">#</span>
        <h1 className="text-white font-bold text-xl">main</h1>
        <span className="text-gray-500 text-sm ml-2">General chat</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto bg-gray-900 rounded-xl p-4 space-y-1 min-h-0">
        {history.length === 0 && (
          <p className="text-gray-600 text-sm text-center py-8">
            No messages yet. Say something!
          </p>
        )}
        {history.map((msg, i) => {
          const prevMsg = history[i - 1];
          const grouped = prevMsg?.userId === msg.userId &&
            new Date(msg.createdAt).getTime() - new Date(prevMsg.createdAt).getTime() < 5 * 60_000;
          const isMe = msg.userId === user?.id;

          return (
            <div key={msg.id} className={`flex gap-3 ${grouped ? "mt-0.5" : "mt-3"}`}>
              {/* Avatar placeholder */}
              <div className={`w-8 shrink-0 ${grouped ? "" : "mt-0.5"}`}>
                {!grouped && (
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                    isMe ? "bg-blue-700 text-white" : "bg-gray-700 text-gray-300"
                  }`}>
                    {msg.user.username[0].toUpperCase()}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                {!grouped && (
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className={`text-sm font-semibold ${isMe ? "text-blue-400" : "text-gray-200"}`}>
                      {msg.user.username}
                    </span>
                    <span className="text-gray-600 text-xs">{formatTime(msg.createdAt)}</span>
                  </div>
                )}
                <p className="text-gray-300 text-sm break-words">{msg.content}</p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="mt-3 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message #main"
          maxLength={500}
          className="flex-1 bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-gray-500 focus:outline-none text-sm"
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim()}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
