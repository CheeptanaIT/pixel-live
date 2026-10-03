import * as v from "valibot";
import {
  CHUNK_BYTES,
  ControlMessage,
  MAX_CONTROL_CHARS,
  MAX_FILE_BYTES,
  spriteShas,
  type AvatarSpec,
} from "../../shared/p2p";
import type { BlobStore } from "./blobs";
import { fromBase64, joinChunks, sha256Hex, splitChunks, toBase64 } from "./bytes";

export interface PeerChannel {
  /** May return a promise that resolves once the channel has room (backpressure). */
  send(text: string): Promise<void> | void;
}

export interface SyncDeps {
  store: BlobStore;
  /** True only for a PNG we are willing to decode (format and dimensions are checked here). */
  accept(bytes: Uint8Array<ArrayBuffer>): Promise<boolean>;
  /** A peer's avatar is complete: every file it names is now in the store. */
  onAvatar(peerId: string, spec: AvatarSpec): void;
  now?: () => number;
}

/** Same file to the same peer at most this often, so `want` spam cannot multiply our upload. */
const RESERVE_MS = 5000;

interface Incoming {
  total: number;
  parts: (Uint8Array<ArrayBuffer> | undefined)[];
  got: number;
  bytes: number;
}

interface PeerState {
  channel: PeerChannel;
  spec?: AvatarSpec;
  /** Files we asked this peer for. Anything else they send is ignored. */
  wanted: Set<string>;
  incoming: Map<string, Incoming>;
  served: Map<string, number>;
  queue: Promise<void>;
}

/**
 * Keeps everybody's avatar in sync over the data channel: announce ours with `profile`, ask for
 * files we lack with `want`, answer with `file` chunks. Content-addressed (sha256), so a file is
 * verified before it is trusted and never fetched twice.
 */
export class AvatarSync {
  private readonly peers = new Map<string, PeerState>();
  private mine?: AvatarSpec;

  constructor(private readonly deps: SyncDeps) {}

  setMine(spec: AvatarSpec) {
    this.mine = spec;
    for (const st of this.peers.values()) this.sendProfile(st);
  }

  peerOpen(peerId: string, channel: PeerChannel) {
    const st: PeerState = {
      channel,
      wanted: new Set(),
      incoming: new Map(),
      served: new Map(),
      queue: Promise.resolve(),
    };
    this.peers.set(peerId, st);
    this.sendProfile(st);
  }

  peerClose(peerId: string) {
    this.peers.delete(peerId);
  }

  /** Messages from one peer are processed strictly in order. */
  handle(peerId: string, text: string): Promise<void> {
    const st = this.peers.get(peerId);
    if (!st) return Promise.resolve();
    st.queue = st.queue.then(() => this.process(peerId, st, text)).catch(() => undefined);
    return st.queue;
  }

  private sendProfile(st: PeerState) {
    if (!this.mine) return;
    void Promise.resolve(st.channel.send(JSON.stringify({ t: "profile", avatar: this.mine }))).catch(() => undefined);
  }

  private async process(peerId: string, st: PeerState, text: string) {
    if (text.length > MAX_CONTROL_CHARS) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = v.safeParse(ControlMessage, json);
    if (!parsed.success) return;
    const msg = parsed.output;
    switch (msg.t) {
      case "profile":
        return this.onProfile(peerId, st, msg.avatar);
      case "want":
        return this.onWant(st, msg.sha);
      case "file":
        return this.onFile(peerId, st, msg);
    }
  }

  private async onProfile(peerId: string, st: PeerState, avatar: AvatarSpec) {
    st.spec = avatar;
    st.wanted.clear();
    st.incoming.clear();

    const missing: string[] = [];
    for (const sha of spriteShas(avatar)) if (!(await this.deps.store.get(sha))) missing.push(sha);
    if (st.spec !== avatar) return; // a newer profile arrived while we were checking

    if (missing.length === 0) {
      this.deps.onAvatar(peerId, avatar);
      return;
    }
    for (const sha of missing) {
      st.wanted.add(sha);
      await st.channel.send(JSON.stringify({ t: "want", sha }));
    }
  }

  private async onWant(st: PeerState, sha: string) {
    // Only ever serve our own avatar files, never arbitrary cache contents.
    if (!this.mine || !spriteShas(this.mine).includes(sha)) return;
    const now = (this.deps.now ?? Date.now)();
    const last = st.served.get(sha);
    if (last !== undefined && now - last < RESERVE_MS) return;
    st.served.set(sha, now);

    const bytes = await this.deps.store.get(sha);
    if (!bytes) return;
    const chunks = splitChunks(bytes, CHUNK_BYTES);
    for (const [seq, chunk] of chunks.entries()) {
      await st.channel.send(JSON.stringify({ t: "file", sha, seq, total: chunks.length, data: toBase64(chunk) }));
    }
  }

  private async onFile(peerId: string, st: PeerState, msg: Extract<v.InferOutput<typeof ControlMessage>, { t: "file" }>) {
    if (!st.wanted.has(msg.sha)) return; // unsolicited

    let inc = st.incoming.get(msg.sha);
    if (!inc) {
      inc = { total: msg.total, parts: new Array(msg.total).fill(undefined), got: 0, bytes: 0 };
      st.incoming.set(msg.sha, inc);
    }
    const abandon = () => {
      st.incoming.delete(msg.sha);
      st.wanted.delete(msg.sha);
    };
    if (inc.total !== msg.total || msg.seq >= inc.total) return abandon();
    if (inc.parts[msg.seq]) return; // duplicate chunk

    const chunk = fromBase64(msg.data);
    if (!chunk || chunk.length === 0 || chunk.length > CHUNK_BYTES) return abandon();
    inc.bytes += chunk.length;
    if (inc.bytes > MAX_FILE_BYTES) return abandon();
    inc.parts[msg.seq] = chunk;
    inc.got++;
    if (inc.got < inc.total) return;

    const bytes = joinChunks(inc.parts as Uint8Array<ArrayBuffer>[]);
    st.incoming.delete(msg.sha);
    const ok = (await sha256Hex(bytes)) === msg.sha && (await this.deps.accept(bytes));
    st.wanted.delete(msg.sha); // success or not, no retry: a bad file stays bad
    if (!ok) return;
    await this.deps.store.put(msg.sha, bytes);

    if (st.wanted.size > 0 || !st.spec) return;
    for (const sha of spriteShas(st.spec)) if (!(await this.deps.store.get(sha))) return;
    this.deps.onAvatar(peerId, st.spec);
  }
}
