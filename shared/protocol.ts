import * as v from "valibot";

export const MAX_SPEAKERS = 10;
export const MAX_STAGES = 2;
/** Largest legitimate message is an SDP offer/answer (a few KB); anything bigger is abuse. */
export const MAX_MESSAGE_CHARS = 16 * 1024;
/** Sockets per room, joined or not. Real use tops out near 14 (12 seats plus refresh overlap). */
export const MAX_SOCKETS_PER_ROOM = 24;

/**
 * Token bucket per socket for incoming messages. Measured in a real browser: a newcomer sends
 * about 5 messages per peer already in the room (hello, offer, a few trickled ICE candidates), so
 * ~60 for a full room. Real networks yield several times more candidates per pair (server-reflexive,
 * IPv6, relay), so the burst is 10x the measurement; afterwards a healthy client sends almost nothing.
 */
export const RATE = {
  burst: 600,
  perSecond: 20,
  /** Dropped messages in a row (the bucket never recovering) before the socket is closed. */
  maxDrops: 100,
} as const;
export const MAX_NAME_LENGTH = 24;

/** WebSocket close codes >= 4000 are final: the client must not reconnect. */
export const CLOSE = { REPLACED: 4000, REJECTED: 4001, KICKED: 4002 } as const;

const PeerId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,32}$/));
const HostKey = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const Name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_NAME_LENGTH));
const Role = v.picklist(["speaker", "stage"]);

export const ClientMessage = v.variant("t", [
  v.object({
    t: v.literal("hello"),
    peerId: PeerId,
    name: Name,
    role: Role,
    hostKey: v.optional(HostKey),
  }),
  v.object({ t: v.literal("signal"), to: PeerId, data: v.unknown() }),
  v.object({ t: v.literal("kick"), peerId: PeerId }),
  v.object({ t: v.literal("lock"), locked: v.boolean() }),
]);

/**
 * Payload of `signal`. The relay passes it through untouched, so receivers must validate:
 * it is whatever another (possibly hostile) client chose to send.
 */
export const SignalData = v.union([
  v.object({
    description: v.object({ type: v.picklist(["offer", "answer"]), sdp: v.string() }),
  }),
  v.object({
    candidate: v.object({
      candidate: v.string(),
      sdpMid: v.optional(v.nullable(v.string())),
      sdpMLineIndex: v.optional(v.nullable(v.number())),
      usernameFragment: v.optional(v.nullable(v.string())),
    }),
  }),
]);

export type SignalData = v.InferOutput<typeof SignalData>;
export type ClientMessage = v.InferOutput<typeof ClientMessage>;
export type Hello = Extract<ClientMessage, { t: "hello" }>;
export type Role = v.InferOutput<typeof Role>;

export interface Peer {
  peerId: string;
  name: string;
  role: Role;
  isHost: boolean;
}

export type ErrorCode =
  | "FULL"
  | "LOCKED"
  | "KICKED"
  | "REPLACED"
  | "BAD_ROOM"
  | "BAD_KEY"
  | "BAD_MESSAGE"
  | "FORBIDDEN"
  | "RATE_LIMITED";

export type ServerMessage =
  | { t: "welcome"; you: Peer; locked: boolean; peers: Peer[] }
  | { t: "join"; peer: Peer }
  | { t: "leave"; peerId: string }
  | { t: "lock"; locked: boolean }
  | { t: "signal"; from: string; data: unknown }
  | { t: "error"; code: ErrorCode };
