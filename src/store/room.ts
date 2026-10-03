import { create } from "zustand";
import type { ErrorCode, Peer, ServerMessage } from "../../shared/protocol";
import { Signaling } from "../net/signaling";
import { getHostKey, getPeerId, setName } from "./me";

export type Status = "idle" | "connecting" | "online" | "reconnecting" | "ended";

/** Errors after which the server closes the socket for good. */
const FATAL: ReadonlySet<ErrorCode> = new Set(["FULL", "LOCKED", "KICKED", "REPLACED", "BAD_KEY"]);

interface RoomState {
  status: Status;
  endReason?: ErrorCode;
  me?: Peer;
  peers: Peer[];
  locked: boolean;
}

const initial: RoomState = { status: "idle", peers: [], locked: false };

export const useRoom = create<RoomState>(() => initial);

let signaling: Signaling | undefined;

export function connectRoom(roomId: string, name: string) {
  disconnectRoom();
  setName(name);
  useRoom.setState({ ...initial, status: "connecting" });

  const s = new Signaling(
    roomId,
    () => ({ t: "hello", peerId: getPeerId(), name, role: "speaker", hostKey: getHostKey(roomId) }),
    {
      onState(state) {
        if (signaling !== s) return;
        if (state === "closed") {
          useRoom.setState((cur) => ({ status: "ended", endReason: cur.endReason }));
        } else if (state === "reconnecting") {
          useRoom.setState({ status: "reconnecting" });
        }
      },
      onMessage(msg) {
        if (signaling === s) apply(msg);
      },
    },
  );
  signaling = s;
  s.start();
}

export function disconnectRoom() {
  signaling?.stop();
  signaling = undefined;
  useRoom.setState(initial);
}

export function kickPeer(peerId: string) {
  signaling?.send({ t: "kick", peerId });
}

export function setLocked(locked: boolean) {
  signaling?.send({ t: "lock", locked });
}

function apply(msg: ServerMessage) {
  switch (msg.t) {
    case "welcome":
      // Also runs after a reconnect: the welcome is the source of truth, so replace everything.
      useRoom.setState({ status: "online", endReason: undefined, me: msg.you, peers: msg.peers, locked: msg.locked });
      return;
    case "join":
      useRoom.setState((cur) => ({
        peers: [...cur.peers.filter((p) => p.peerId !== msg.peer.peerId), msg.peer],
      }));
      return;
    case "leave":
      useRoom.setState((cur) => ({ peers: cur.peers.filter((p) => p.peerId !== msg.peerId) }));
      return;
    case "lock":
      useRoom.setState({ locked: msg.locked });
      return;
    case "error":
      if (FATAL.has(msg.code)) useRoom.setState({ endReason: msg.code });
      else console.warn("relay error:", msg.code);
      return;
    case "signal":
      return; // WebRTC arrives in M2
  }
}
