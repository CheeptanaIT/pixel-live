import { create } from "zustand";
import type { ErrorCode, Peer, Role, ServerMessage } from "../../shared/protocol";
import { DEFAULT_SCENE, type AvatarSpec, type EmoteId } from "../../shared/p2p";
import { artFromSeed, artFromSpec, acceptPng, type AvatarArt } from "../avatar/art";
import { blobStore } from "../avatar/blobs";
import { getMySpec, saveMySpec } from "../avatar/local";
import { AvatarSync } from "../avatar/transfer";
import { levels } from "../audio/levels";
import { emoteBus } from "../stage/emotes";
import { acceptBackground, createBackgroundPng, resolveScene } from "../stage/background";
import { sha256Hex } from "../avatar/bytes";
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
  /** Drawable art by peerId once known; peers missing here are drawn as generated characters. */
  avatars: Record<string, AvatarArt>;
  /** The room's background: its id, and the picture (null = the built-in default). */
  scene: { id: string; canvas: HTMLCanvasElement | null };
  /** The browser is holding playback back until the user clicks (never true inside OBS). */
  audioBlocked: boolean;
}

const initial: RoomState = {
  status: "idle",
  peers: [],
  locked: false,
  links: {},
  hasMic: false,
  muted: false,
  avatars: {},
  scene: { id: DEFAULT_SCENE, canvas: null },
  audioBlocked: false,
};

export const useRoom = create<RoomState>(() => initial);

let signaling: Signaling | undefined;
let mesh: Mesh | undefined;
let sync: AvatarSync | undefined;
let mic: MediaStream | null = null;

function setAvatar(peerId: string, art: AvatarArt) {
  useRoom.setState((cur) => ({ avatars: { ...cur.avatars, [peerId]: art } }));
}

function dropAvatar(peerId: string) {
  useRoom.setState((cur) => {
    if (!(peerId in cur.avatars)) return cur;
    const avatars = { ...cur.avatars };
    delete avatars[peerId];
    return { avatars };
  });
}

/**
 * `stream` is the already-opened mic, or null to join as a listener. The store owns it from here.
 * `role: "stage"` is the OBS page: it only listens, has no character, and must not overwrite the
 * name this browser remembers for the real user.
 */
export function connectRoom(roomId: string, name: string, stream: MediaStream | null, role: Role = "speaker") {
  disconnectRoom();
  if (role === "speaker") setName(name);
  mic = stream;
  useRoom.setState({ ...initial, status: "connecting", hasMic: stream !== null });

  const selfId = getPeerId();
  const s = new Signaling(
    roomId,
    () => ({ t: "hello", peerId: selfId, name, role, hostKey: getHostKey(roomId) }),
    {
      onState(state) {
        if (signaling !== s) return;
        if (state === "closed") {
          // Final close: nobody is going to use the mic or the peer connections any more.
          mesh?.close();
          stopStream(mic);
          mic = null;
          levels.clear();
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
    onChannelOpen: (peerId) =>
      sync?.peerOpen(peerId, { send: (text) => mesh?.sendControl(peerId, text) }),
    onChannelClose: (peerId) => sync?.peerClose(peerId),
    onControl: (peerId, text) => void sync?.handle(peerId, text),
    onLinkState(peerId, state) {
      if (state === null) {
        levels.detach(peerId);
        dropAvatar(peerId);
      }
      useRoom.setState((cur) => {
        const links = { ...cur.links };
        if (state === null) delete links[peerId];
        else links[peerId] = state;
        return { links };
      });
    },
    onStream: (peerId, remote) => levels.attach(peerId, remote),
    onPlaybackBlocked: () => useRoom.setState({ audioBlocked: true }),
  });
  if (stream) levels.attach(selfId, stream);

  // Avatars: announce mine to each peer as its data channel opens, and show theirs once complete.
  const m = mesh;
  sync = new AvatarSync({
    store: blobStore,
    accept: acceptPng,
    acceptScene: acceptBackground,
    isHost: (peerId) => useRoom.getState().peers.some((p) => p.peerId === peerId && p.isHost),
    onScene: (bg) => void showScene(bg, m),
    onEmote: (peerId, id) => emoteBus.emit(peerId, id),
    onAvatar: (peerId, spec) => {
      void artFromSpec(spec, blobStore).then((art) => {
        if (art && mesh === m) setAvatar(peerId, art);
      });
    },
  });
  if (role === "speaker") void applyMyAvatar(getMySpec(), selfId, m);
  if (import.meta.env.DEV) (window as unknown as { __pixelMesh?: Mesh }).__pixelMesh = mesh;
  s.start();
}

export function disconnectRoom() {
  signaling?.stop();
  signaling = undefined;
  mesh?.close();
  mesh = undefined;
  sync = undefined;
  stopStream(mic);
  mic = null;
  levels.clear();
  useRoom.setState(initial);
}

/** True while sound is held back by the browser's autoplay policy (waiting for a click). */
export function isAudioBlocked(): boolean {
  return useRoom.getState().audioBlocked || levels.suspended;
}

/** Call from a user gesture: lets the browser start the audio it was holding back. */
export function resumeAudio() {
  void levels.resume();
  mesh?.resumePlayback();
  useRoom.setState({ audioBlocked: false });
}

/** Show my own avatar locally and announce it to everyone. Falls back to a generated one if files are gone. */
async function applyMyAvatar(spec: AvatarSpec, selfId: string, forMesh: Mesh | undefined) {
  const art = (await artFromSpec(spec, blobStore)) ?? artFromSeed(selfId);
  if (mesh !== forMesh) return;
  setAvatar(selfId, art);
  sync?.setMine(spec);
}

let sceneSeq = 0;

/**
 * Draw the scene `bg` here. Returns false (and draws nothing) if its picture cannot be loaded, if
 * we left the room, or if a newer scene was requested while this one was still loading.
 */
async function showScene(bg: string, forMesh: Mesh | undefined): Promise<boolean> {
  const seq = ++sceneSeq;
  const canvas = await resolveScene(bg, blobStore);
  if (!canvas || mesh !== forMesh || seq !== sceneSeq) return false;
  useRoom.setState({ scene: { id: bg, canvas } });
  return true;
}

/**
 * Host only: change the background for everybody (the server never sees it, peers just obey the
 * host). Only a scene that really loaded here is announced, so what we show and what peers show agree.
 */
export async function setScene(bg: string) {
  if (!useRoom.getState().me?.isHost) return;
  const forMesh = mesh;
  if (await showScene(bg, forMesh)) sync?.setScene(bg);
}

/** Host only: shrink an uploaded picture into a background, store it and make it the scene. */
export async function uploadScene(file: File) {
  const bytes = await createBackgroundPng(file);
  const sha = await sha256Hex(bytes);
  await blobStore.put(sha, bytes);
  await setScene(sha);
}

/** Change my avatar mid-call: remember it, redraw it, tell every peer. */
export async function setMyAvatar(spec: AvatarSpec) {
  saveMySpec(spec);
  await applyMyAvatar(spec, getPeerId(), mesh);
}

/** Show my emote on my own stage at once and send it to everybody else. Listeners-only stage pages never call this. */
export function sendEmote(id: EmoteId) {
  if (useRoom.getState().status !== "online") return;
  emoteBus.emit(getPeerId(), id);
  mesh?.broadcastControl(JSON.stringify({ t: "emote", id }));
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
  levels.attach(getPeerId(), next);
}

function apply(msg: ServerMessage) {
  switch (msg.t) {
    case "welcome":
      // Also runs after a reconnect: the welcome is the source of truth, so replace everything.
      useRoom.setState({ status: "online", endReason: undefined, me: msg.you, peers: msg.peers, locked: msg.locked });
      mesh?.reset(msg.peers);
      sync?.recheckHosts();
      // After a reconnect the host's own choice is still ours to announce; peerOpen re-sends it.
      return;
    case "join":
      useRoom.setState((cur) => ({
        peers: [...cur.peers.filter((p) => p.peerId !== msg.peer.peerId), msg.peer],
      }));
      sync?.recheckHosts();
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
