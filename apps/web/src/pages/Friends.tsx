import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

interface Friend {
  id: string;
  username: string;
  connectCode: string;
}

interface IncomingRequest {
  id: string;
  requesterId: string;
  status: "PENDING";
  createdAt: string;
  requester: Friend;
}

export default function Friends() {
  useAuthStore();
  const queryClient = useQueryClient();
  const [connectCode, setConnectCode] = useState("");
  const [sendError, setSendError] = useState("");
  const [sendSuccess, setSendSuccess] = useState("");

  const { data: friends = [], isLoading: loadingFriends } = useQuery<Friend[]>({
    queryKey: ["friends"],
    queryFn: () => api.get("/friends").then((r) => r.data),
  });

  const { data: incoming = [] } = useQuery<IncomingRequest[]>({
    queryKey: ["friends", "incoming"],
    queryFn: () => api.get("/friends/requests/incoming").then((r) => r.data),
  });

  // Real-time friend request notifications
  useEffect(() => {
    const socket = getSocket();
    socket.on("friend:request", () => {
      queryClient.invalidateQueries({ queryKey: ["friends", "incoming"] });
    });
    return () => { socket.off("friend:request"); };
  }, [queryClient]);

  const sendRequest = useMutation({
    mutationFn: (code: string) => api.post("/friends/request", { connectCode: code }),
    onSuccess: () => {
      setSendSuccess("Friend request sent!");
      setSendError("");
      setConnectCode("");
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Failed to send request";
      setSendError(msg);
      setSendSuccess("");
    },
  });

  const acceptRequest = useMutation({
    mutationFn: (id: string) => api.patch(`/friends/request/${id}/accept`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["friends"] });
      queryClient.invalidateQueries({ queryKey: ["friends", "incoming"] });
    },
  });

  const declineRequest = useMutation({
    mutationFn: (id: string) => api.patch(`/friends/request/${id}/decline`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["friends", "incoming"] }),
  });

  const removeFriend = useMutation({
    mutationFn: (friendId: string) => api.delete(`/friends/${friendId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["friends"] }),
  });

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-6">Friends</h1>

      {/* Incoming requests */}
      {incoming.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-5 mb-6">
          <h2 className="text-white font-semibold mb-3">
            Incoming Requests{" "}
            <span className="text-xs bg-blue-700 text-blue-200 px-2 py-0.5 rounded-full ml-1">
              {incoming.length}
            </span>
          </h2>
          <div className="space-y-3">
            {incoming.map((req) => (
              <div key={req.id} className="flex items-center justify-between">
                <div>
                  <span className="text-white font-medium">{req.requester.username}</span>
                  <span className="text-gray-400 text-sm font-mono ml-2">
                    {req.requester.connectCode}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => acceptRequest.mutate(req.id)}
                    disabled={acceptRequest.isPending}
                    className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => declineRequest.mutate(req.id)}
                    disabled={declineRequest.isPending}
                    className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 text-sm px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add friend */}
      <div className="bg-gray-800 rounded-xl p-5 mb-6">
        <h2 className="text-white font-semibold mb-3">Add Friend by Connect Code</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={connectCode}
            onChange={(e) => setConnectCode(e.target.value.toUpperCase())}
            placeholder="FOXT#123"
            className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-2.5 font-mono border border-gray-600 focus:border-blue-500 focus:outline-none"
            maxLength={10}
          />
          <button
            onClick={() => { if (connectCode) sendRequest.mutate(connectCode); }}
            disabled={sendRequest.isPending || !connectCode}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
          >
            {sendRequest.isPending ? "Sending..." : "Send Request"}
          </button>
        </div>
        {sendSuccess && <p className="text-green-400 text-sm mt-2">{sendSuccess}</p>}
        {sendError && <p className="text-red-400 text-sm mt-2">{sendError}</p>}
      </div>

      {/* Friends list */}
      <div>
        <h2 className="text-white font-semibold mb-3">
          Your Friends{" "}
          <span className="text-gray-500 text-sm font-normal">({friends.length})</span>
        </h2>

        {loadingFriends ? (
          <p className="text-gray-400 text-center py-8">Loading...</p>
        ) : friends.length === 0 ? (
          <div className="bg-gray-800 rounded-xl p-8 text-center">
            <p className="text-gray-400">No friends yet. Send a request above!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {friends.map((friend) => (
              <div
                key={friend.id}
                className="bg-gray-800 rounded-xl p-4 flex items-center justify-between"
              >
                <div>
                  <span className="text-white font-semibold">{friend.username}</span>
                  <span className="text-gray-400 text-sm font-mono ml-3">{friend.connectCode}</span>
                </div>
                <button
                  onClick={() => removeFriend.mutate(friend.id)}
                  disabled={removeFriend.isPending}
                  className="text-gray-500 hover:text-red-400 text-sm transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
