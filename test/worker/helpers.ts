import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import { generateHostKey, roomIdFromHostKey } from "../../shared/room";

type Sent = ClientMessage | { t: string; [k: string]: unknown };

/** A WebSocket client with an inbox, for talking to the real Worker + RoomDO in tests. */
export class Client {
  private queue: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      this.queue.push(JSON.parse(e.data as string));
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((res) => ws.addEventListener("close", (e) => res(e.code)));
  }

  send(msg: Sent) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message must be of `type`; strict so ordering bugs show up. */
  async next<T extends ServerMessage["t"]>(type: T): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 2000;
    while (this.queue.length === 0) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${type}"`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    const msg = this.queue.shift()!;
    expect(msg.t).toBe(type);
    return msg as Extract<ServerMessage, { t: T }>;
  }

  /** Everything received so far, removed from the inbox. */
  drain(): ServerMessage[] {
    return this.queue.splice(0);
  }

  async expectSilence(ms = 80) {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.queue).toEqual([]);
  }
}

export async function room() {
  const hostKey = generateHostKey();
  return { hostKey, roomId: await roomIdFromHostKey(hostKey) };
}

export async function connect(roomId: string, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`https://pixel.test/ws/${roomId}`, { headers: { Upgrade: "websocket", ...headers } });
  const ws = res.webSocket!;
  ws.accept();
  return new Client(ws);
}

let seq = 0;
export const newPeerId = () => `peer-${++seq}-${crypto.randomUUID().slice(0, 8)}`;

export async function join(
  roomId: string,
  opts: { name?: string; role?: "speaker" | "stage"; hostKey?: string; peerId?: string } = {},
) {
  const c = await connect(roomId);
  const peerId = opts.peerId ?? newPeerId();
  c.send({ t: "hello", peerId, name: opts.name ?? "Tester", role: opts.role ?? "speaker", hostKey: opts.hostKey });
  return { c, peerId };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
