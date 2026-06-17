import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { useAuthStore } from "../hooks/useAuth";
import { useMessenger } from "../hooks/useMessenger";

// Facebook-Messenger-style docked chat in the bottom-right. Entrants DM each
// other; open a conversation from the speech-bubble next to an entrant on the
// tournament page, or from the conversation list here. Realtime via the
// "dm:message" socket event, with a polling fallback.

interface DMUser {
  id: string;
  username: string;
}
interface Conversation {
  peer: DMUser;
  lastMessage: { content: string; createdAt: string; fromMe: boolean };
}
interface DMMessage {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
  user: DMUser;
}

// Client-side read tracking (the API doesn't persist per-user read state).
function lastReadKey(peerId: string) {
  return `dm_read_${peerId}`;
}
function markRead(peerId: string) {
  localStorage.setItem(lastReadKey(peerId), new Date().toISOString());
}
function isUnread(c: Conversation) {
  if (c.lastMessage.fromMe) return false;
  const read = localStorage.getItem(lastReadKey(c.peer.id));
  return !read || new Date(c.lastMessage.createdAt) > new Date(read);
}

export default function Messenger() {
  const user = useAuthStore((s) => s.user);
  const { openPeer, consumeOpen } = useMessenger();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activePeer, setActivePeer] = useState<DMUser | null>(null);
  const [draft, setDraft] = useState("");
  const [readTick, setReadTick] = useState(0); // forces unread recompute after markRead
  const scrollRef = useRef<HTMLDivElement>(null);

  // Open a specific conversation when requested from elsewhere (entrants list).
  useEffect(() => {
    if (!openPeer) return;
    setActivePeer(openPeer);
    setOpen(true);
    consumeOpen();
  }, [openPeer, consumeOpen]);

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["dm-conversations"],
    queryFn: () => api.get("/messages").then((r) => r.data),
    enabled: !!user,
    refetchInterval: 15000,
  });

  const { data: history = [] } = useQuery<DMMessage[]>({
    queryKey: ["dm-history", activePeer?.id],
    queryFn: () => api.get(`/messages/${activePeer!.id}`).then((r) => r.data),
    enabled: !!user && !!activePeer && open,
  });

  // Realtime: refresh the list (and the open thread) on incoming/sent messages.
  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    const onMsg = () => {
      qc.invalidateQueries({ queryKey: ["dm-conversations"] });
      qc.invalidateQueries({ queryKey: ["dm-history"] });
    };
    socket.on("dm:message", onMsg);
    return () => {
      socket.off("dm:message", onMsg);
    };
  }, [user, qc]);

  // Mark the open conversation read whenever its messages change.
  useEffect(() => {
    if (open && activePeer) {
      markRead(activePeer.id);
      setReadTick((t) => t + 1);
    }
  }, [open, activePeer, history.length]);

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history.length, activePeer, open]);

  const send = useMutation({
    mutationFn: (content: string) =>
      api.post(`/messages/${activePeer!.id}`, { content }).then((r) => r.data),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["dm-history", activePeer?.id] });
      qc.invalidateQueries({ queryKey: ["dm-conversations"] });
    },
  });

  const unreadCount = useMemo(
    () => conversations.filter(isUnread).length,
    // readTick invalidates the memo after markRead writes localStorage
    [conversations, readTick]
  );

  if (!user) return null;

  return (
    <div className="fixed bottom-0 right-4 z-50 w-80 max-w-[calc(100vw-2rem)]">
      {open && (
        <div className="bg-gray-900 border border-gray-700 border-b-0 rounded-t-xl h-[26rem] flex flex-col shadow-2xl overflow-hidden">
          {activePeer ? (
            <>
              {/* Conversation header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
                <button
                  onClick={() => setActivePeer(null)}
                  className="text-gray-400 hover:text-white text-sm"
                  title="Back to conversations"
                >
                  ←
                </button>
                <span className="text-white font-semibold text-sm truncate">{activePeer.username}</span>
              </div>
              {/* Thread */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                {history.length === 0 ? (
                  <p className="text-gray-500 text-xs text-center mt-4">
                    No messages yet. Say hi to {activePeer.username}.
                  </p>
                ) : (
                  history.map((m) => {
                    const mine = m.userId === user.id;
                    return (
                      <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <span
                          className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm break-words ${
                            mine ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-100"
                          }`}
                        >
                          {m.content}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
              {/* Composer */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = draft.trim();
                  if (text && !send.isPending) send.mutate(text);
                }}
                className="flex items-center gap-2 p-2 border-t border-gray-800 shrink-0"
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={500}
                  placeholder="Message…"
                  className="flex-1 bg-gray-800 text-white text-sm rounded-full px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500/50"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || send.isPending}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium px-3 py-1.5 rounded-full"
                >
                  Send
                </button>
              </form>
            </>
          ) : (
            // Conversation list
            <div className="flex-1 overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="text-gray-500 text-xs text-center mt-6 px-4">
                  No conversations yet. Message an entrant from the tournament page.
                </p>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.peer.id}
                    onClick={() => setActivePeer(c.peer)}
                    className="w-full text-left px-3 py-2.5 hover:bg-gray-800 border-b border-gray-800/60 flex items-center gap-2"
                  >
                    {isUnread(c) && <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm truncate ${isUnread(c) ? "text-white font-semibold" : "text-gray-200"}`}>
                        {c.peer.username}
                      </span>
                      <span className="block text-xs text-gray-500 truncate">
                        {c.lastMessage.fromMe ? "You: " : ""}
                        {c.lastMessage.content}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Docked header bar (always visible) */}
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (open) setActivePeer(null);
        }}
        className="w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-t-xl px-4 py-2.5 flex items-center justify-between text-white shadow-2xl"
      >
        <span className="flex items-center gap-2 font-semibold text-sm">
          <SpeechBubbleIcon />
          Messages
        </span>
        {unreadCount > 0 ? (
          <span className="bg-blue-500 text-white text-xs font-bold rounded-full min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center">
            {unreadCount}
          </span>
        ) : (
          <span className="text-gray-400 text-xs">{open ? "▾" : "▴"}</span>
        )}
      </button>
    </div>
  );
}

export function SpeechBubbleIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8.5" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
