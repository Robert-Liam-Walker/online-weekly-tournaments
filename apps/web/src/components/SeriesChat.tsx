import { useEffect, useRef, useState } from "react";
import { getSocket } from "../lib/socket";
import { useAuthStore } from "../hooks/useAuth";

interface ChatMsg {
  userId: string;
  username: string;
  content: string;
  timestamp: string;
}

export default function SeriesChat({ seriesId }: { seriesId: string }) {
  const { user } = useAuthStore();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = getSocket();
    socket.emit("series:join", { seriesId });

    socket.on("series:chat:message", (msg: ChatMsg) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => { socket.off("series:chat:message"); };
  }, [seriesId]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, open]);

  function send() {
    const trimmed = input.trim();
    if (!trimmed) return;
    getSocket().emit("series:chat:send", { seriesId, content: trimmed });
    setInput("");
  }

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-white font-semibold text-sm hover:bg-gray-750 transition-colors"
      >
        <span>Match Chat</span>
        <span className="text-gray-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <>
          <div className="h-48 overflow-y-auto px-4 py-2 space-y-1 bg-gray-900">
            {messages.length === 0 && (
              <p className="text-gray-600 text-xs text-center py-4">
                Only you and your opponent can see this.
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={i} className="text-sm">
                <span className={`font-semibold mr-1 ${msg.userId === user?.id ? "text-blue-400" : "text-gray-300"}`}>
                  {msg.username}
                </span>
                <span className="text-gray-400">{msg.content}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="flex gap-2 p-2 border-t border-gray-700">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder="Say something..."
              maxLength={500}
              className="flex-1 bg-gray-700 text-white rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-500"
            />
            <button
              onClick={send}
              disabled={!input.trim()}
              className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white px-3 py-1.5 rounded text-sm transition-colors"
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
