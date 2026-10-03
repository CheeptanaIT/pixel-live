import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import {
  CLOSE,
  ClientMessage,
  MAX_MESSAGE_CHARS,
  MAX_SPEAKERS,
  MAX_STAGES,
  type ErrorCode,
  type Hello,
  type Peer,
  type ServerMessage,
} from "../shared/protocol";
import { roomIdFromHostKey } from "../shared/room";

/**
 * Survives hibernation via serializeAttachment, so the room needs no storage at all.
 * `peer` is unset until the socket has sent a valid hello (and again once it is evicted).
 * `locked` is mirrored on every socket; the room is unlocked once the last socket is gone.
 */
interface Attachment {
  roomId: string;
  peer?: Peer;
  locked: boolean;
}

interface Member {
  ws: WebSocket;
  att: Attachment & { peer: Peer };
}

/** One instance per room. Pure relay: signaling + membership, never touches ctx.storage. */
export class RoomDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const roomId = new URL(request.url).pathname.split("/").pop() ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ roomId, locked: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_CHARS) {
      ws.close(1009, "bad frame");
      return;
    }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    let parsed: ReturnType<typeof v.safeParse<typeof ClientMessage>>;
    try {
      parsed = v.safeParse(ClientMessage, JSON.parse(raw));
    } catch {
      parsed = { success: false } as typeof parsed;
    }
    if (!parsed.success) return this.badMessage(ws, att);
    const msg = parsed.output;

    if (!att.peer) {
      if (msg.t !== "hello") return this.badMessage(ws, att);
      return this.onHello(ws, att.roomId, msg);
    }

    switch (msg.t) {
      case "hello":
        return; // already joined
      case "signal": {
        const target = this.members().find((m) => m.att.peer.peerId === msg.to);
        if (target) this.send(target.ws, { t: "signal", from: att.peer.peerId, data: msg.data });
        return;
      }
      case "lock": {
        if (!att.peer.isHost) return this.send(ws, { t: "error", code: "FORBIDDEN" });
        for (const m of this.members()) m.ws.serializeAttachment({ ...m.att, locked: msg.locked });
        this.broadcast({ t: "lock", locked: msg.locked });
        return;
      }
      case "kick": {
        if (!att.peer.isHost) return this.send(ws, { t: "error", code: "FORBIDDEN" });
        const target = this.members().find((m) => m.att.peer.peerId === msg.peerId);
        if (target && target.ws !== ws) this.evict(target, "KICKED", CLOSE.KICKED);
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.removePeer(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.removePeer(ws);
  }

  private async onHello(ws: WebSocket, roomId: string, msg: Hello) {
    let isHost = false;
    if (msg.hostKey !== undefined) {
      isHost = (await roomIdFromHostKey(msg.hostKey)) === roomId;
      if (!isHost) return this.reject(ws, "BAD_KEY");
    }
    isHost &&= msg.role === "speaker";

    // The await above lets other messages interleave, so everything from here on stays
    // synchronous: capacity checks and the attachment commit must not be split up.
    if ((ws.deserializeAttachment() as Attachment).peer) return;

    const members = this.members();
    const locked = members.some((m) => m.att.locked);
    if (locked && !isHost) return this.reject(ws, "LOCKED");

    const others = members.filter((m) => m.att.peer.peerId !== msg.peerId);
    const taken = others.filter((m) => m.att.peer.role === msg.role).length;
    if (taken >= (msg.role === "speaker" ? MAX_SPEAKERS : MAX_STAGES)) {
      return this.reject(ws, "FULL");
    }

    // Same peerId again (refresh, second tab): the newest connection wins.
    for (const stale of members.filter((m) => m.att.peer.peerId === msg.peerId)) {
      this.evict(stale, "REPLACED", CLOSE.REPLACED);
    }

    // Same peerId again (refresh, second tab): the newest connection wins.

    const peer: Peer = { peerId: msg.peerId, name: msg.name, role: msg.role, isHost };
    ws.serializeAttachment({ roomId, peer, locked } satisfies Attachment);
    this.send(ws, {
      t: "welcome",
      you: peer,
      locked,
      peers: this.members()
        .filter((m) => m.ws !== ws)
        .map((m) => m.att.peer),
    });
    this.broadcast({ t: "join", peer }, ws);
  }

  private members(): Member[] {
    const out: Member[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.peer) out.push({ ws, att: att as Member["att"] });
    }
    return out;
  }

  private removePeer(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.peer) return;
    ws.serializeAttachment({ ...att, peer: undefined } satisfies Attachment);
    this.broadcast({ t: "leave", peerId: att.peer.peerId }, ws);
  }

  private evict(m: Member, code: ErrorCode, closeCode: number) {
    this.send(m.ws, { t: "error", code });
    this.removePeer(m.ws);
    m.ws.close(closeCode, code);
  }

  private reject(ws: WebSocket, code: ErrorCode) {
    this.send(ws, { t: "error", code });
    ws.close(CLOSE.REJECTED, code);
  }

  /** Garbage from a joined peer is ignored; before hello it ends the connection. */
  private badMessage(ws: WebSocket, att: Attachment) {
    if (att.peer) this.send(ws, { t: "error", code: "BAD_MESSAGE" });
    else this.reject(ws, "BAD_MESSAGE");
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already closing; its close handler will clean up
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    for (const m of this.members()) if (m.ws !== except) this.send(m.ws, msg);
  }
}
