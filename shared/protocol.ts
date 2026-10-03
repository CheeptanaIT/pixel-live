import * as v from "valibot";

export const MAX_SPEAKERS = 10;
export const MAX_STAGES = 2;
export const MAX_MESSAGE_CHARS = 64 * 1024;
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
  | "FORBIDDEN";

export type ServerMessage =
  | { t: "welcome"; you: Peer; locked: boolean; peers: Peer[] }
  | { t: "join"; peer: Peer }
  | { t: "leave"; peerId: string }
  | { t: "lock"; locked: boolean }
  | { t: "signal"; from: string; data: unknown }
  | { t: "error"; code: ErrorCode };
