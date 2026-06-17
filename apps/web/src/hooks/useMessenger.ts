import { create } from "zustand";

// Lets any part of the app (e.g. the speech-bubble button next to an entrant)
// pop open the bottom-right messenger on a specific conversation. The Messenger
// widget watches `openPeer`, opens that chat, then calls consumeOpen().
interface MessengerPeer {
  id: string;
  username: string;
}

interface MessengerState {
  openPeer: MessengerPeer | null;
  requestOpen: (peer: MessengerPeer) => void;
  consumeOpen: () => void;
}

export const useMessenger = create<MessengerState>((set) => ({
  openPeer: null,
  requestOpen: (peer) => set({ openPeer: peer }),
  consumeOpen: () => set({ openPeer: null }),
}));
