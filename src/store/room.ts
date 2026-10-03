import { create } from "zustand";
import type { ErrorCode, Peer, ServerMessage } from "../../shared/protocol";
import { openMic, stopStream } from "../audio/mic";
import { Mesh } from "../net/mesh";
import type { LinkState } from "../net/peer";
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
  /** Audio link per remote peer; absent = no link yet. */
  links: Record<string, LinkState>;
  hasMic: boolean;
  muted: boolean;
}

const initial: RoomState = { status: "idle", peers: [], locked: false, links: {}, hasMic: false, muted: false };

export const useRoom = create<RoomState>(() => initial);

let signaling: Signaling | undefined;
let mesh: Mesh | undefined;
let mic: MediaStream | null = null;

/** `stream` is the already-opened mic, or null to join as a listener. The store owns it from here. */
export function connectRoom(roomId: string, name: string, stream: MediaStream | null) {
  disconnectRoom();
  setName(name);
  mic = stream;
  useRoom.setState({ ...initial, status: "connecting", hasMic: stream !== null });

  const selfId = getPeerId();
  const s = new Signaling(
    roomId,
    () => ({ t: "hello", peerId: selfId, name, role: "speaker", hostKey: getHostKey(roomId) }),
    {
      onState(state) {
        if (signaling !== s) return;
        if (state === "closed") {
          // Final close: nobody is going to use the mic or the peer connections any more.
          mesh?.close();
          stopStream(mic);
          mic = null;
          useRoom.setState((cur) => ({ status: "ended", endReason: cur.endReason, hasMic: false }));
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
  mesh = new Mesh(selfId, stream, {
    send: (to, data) => s.send({ t: "signal", to, data }),
    onLinkState(peerId, state) {
      useRoom.setState((cur) => {
        const links = { ...cur.links };
        if (state === null) delete links[peerId];
        else links[peerId] = state;
        return { links };
      });
    },
  });
  if (import.meta.env.DEV) (window as unknown as { __pixelMesh?: Mesh }).__pixelMesh = mesh;
  s.start();
}

export function disconnectRoom() {
  signaling?.stop();
  signaling = undefined;
  mesh?.close();
  mesh = undefined;
  stopStream(mic);
  mic = null;
  useRoom.setState(initial);
}

export function kickPeer(peerId: string) {
  signaling?.send({ t: "kick", peerId });
}

export function setLocked(locked: boolean) {
  signaling?.send({ t: "lock", locked });
}

export function setMuted(muted: boolean) {
  for (const t of mic?.getAudioTracks() ?? []) t.enabled = !muted;
  useRoom.setState({ muted });
}

/** Swap the microphone mid-call without renegotiating. */
export async function switchMic(deviceId: string) {
  const next = await openMic(deviceId);
  for (const t of next.getAudioTracks()) t.enabled = !useRoom.getState().muted;
  await mesh?.replaceTrack(next);
  stopStream(mic);
  mic = next;
}

function apply(msg: ServerMessage) {
  switch (msg.t) {
    case "welcome":
      // Also runs after a reconnect: the welcome is the source of truth, so replace everything.
      useRoom.setState({ status: "online", endReason: undefined, me: msg.you, peers: msg.peers, locked: msg.locked });
      mesh?.reset(msg.peers);
      return;
    case "join":
      useRoom.setState((cur) => ({
        peers: [...cur.peers.filter((p) => p.peerId !== msg.peer.peerId), msg.peer],
      }));
      mesh?.connect(msg.peer, false); // they arrived, so they make the first offer
      return;
    case "leave":
      useRoom.setState((cur) => ({ peers: cur.peers.filter((p) => p.peerId !== msg.peerId) }));
      mesh?.disconnect(msg.peerId);
      return;
    case "lock":
      useRoom.setState({ locked: msg.locked });
      return;
    case "error":
      if (FATAL.has(msg.code)) useRoom.setState({ endReason: msg.code });
      else console.warn("relay error:", msg.code);
      return;
    case "signal":
      mesh?.handleSignal(msg.from, msg.data);
      return;
  }
}
