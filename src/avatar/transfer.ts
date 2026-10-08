import * as v from "valibot";
import {
  CHUNK_BYTES,
  ControlMessage,
  MAX_CONTROL_CHARS,
  MAX_FILE_BYTES,
  sceneSha,
  spriteShas,
  type AvatarSpec,
  type EmoteId,
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
  /** True only for a PNG we are willing to show as a room background. */
  acceptScene(bytes: Uint8Array<ArrayBuffer>): Promise<boolean>;
  /** A peer's avatar is complete: every file it names is now in the store. */
  onAvatar(peerId: string, spec: AvatarSpec): void;
  /** Does the server say this peer is the host? Scene changes from anyone else are ignored. */
  isHost(peerId: string): boolean;
  /** A peer fired an emote (already rate-limited per peer). */
  onEmote(peerId: string, id: EmoteId): void;
  /** The host's scene is ready to draw: built-in, or its file is now in the store. */
  onScene(bg: string): void;
  now?: () => number;
}

/** Same file to the same peer at most this often, so `want` spam cannot multiply our upload. */
const RESERVE_MS = 5000;
/** Emotes from one peer closer together than this are dropped, so nobody can flood the stage. */
const EMOTE_GAP_MS = 150;

type FileKind = "avatar" | "scene";

interface Incoming {
  total: number;
  parts: (Uint8Array<ArrayBuffer> | undefined)[];
  got: number;
  bytes: number;
}

interface PeerState {
  channel: PeerChannel;
  spec?: AvatarSpec;
  /** Scene the host last announced, while its file is still on the way. */
  scene?: string;
  lastEmoteAt?: number;
  /** Latest scene from a peer we did not (yet) know to be the host; re-checked by recheckHosts. */
  unverified?: string;
  /** Files we asked this peer for, and why. Anything else they send is ignored. */
  wanted: Map<string, FileKind>;
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
  /** Only ever set on the host: the scene we announce and serve to everybody. */
  private myScene?: string;

  constructor(private readonly deps: SyncDeps) {}

  setMine(spec: AvatarSpec) {
    this.mine = spec;
    for (const st of this.peers.values()) this.sendProfile(st);
  }

  /** Host only: make this the room's background and tell every peer. */
  setScene(bg: string) {
    this.myScene = bg;
    for (const st of this.peers.values()) this.sendScene(st);
  }

  peerOpen(peerId: string, channel: PeerChannel) {
    const st: PeerState = {
      channel,
      wanted: new Map(),
      incoming: new Map(),
      served: new Map(),
      queue: Promise.resolve(),
    };
    this.peers.set(peerId, st);
    this.sendProfile(st);
    this.sendScene(st);
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

  private sendScene(st: PeerState) {
    if (!this.myScene) return;
    void Promise.resolve(st.channel.send(JSON.stringify({ t: "scene", bg: this.myScene }))).catch(() => undefined);
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
      case "emote": {
        const now = (this.deps.now ?? Date.now)();
        if (st.lastEmoteAt !== undefined && now - st.lastEmoteAt < EMOTE_GAP_MS) return;
        st.lastEmoteAt = now;
        this.deps.onEmote(peerId, msg.id);
        return;
      }
      case "scene":
        return this.onScene(peerId, st, msg.bg);
      case "want":
        return this.onWant(st, msg.sha);
      case "file":
        return this.onFile(peerId, st, msg);
    }
  }

  private async onProfile(peerId: string, st: PeerState, avatar: AvatarSpec) {
    st.spec = avatar;
    this.forget(st, "avatar");

    const missing: string[] = [];
    for (const sha of spriteShas(avatar)) if (!(await this.deps.store.get(sha))) missing.push(sha);
    if (st.spec !== avatar) return; // a newer profile arrived while we were checking

    if (missing.length === 0) {
      this.deps.onAvatar(peerId, avatar);
      return;
    }
    for (const sha of missing) {
      st.wanted.set(sha, "avatar");
      await st.channel.send(JSON.stringify({ t: "want", sha }));
    }
  }

  /** Stop expecting files of one kind (a newer announcement replaces the older one). */
  private forget(st: PeerState, kind: FileKind) {
    for (const [sha, k] of [...st.wanted]) {
      if (k !== kind) continue;
      st.wanted.delete(sha);
      st.incoming.delete(sha);
    }
  }

  /**
   * Call after the roster changes: a `scene` can arrive before we have heard that its sender is
   * the host (channel opens just before the join/welcome is applied), so it is held until then.
   */
  recheckHosts() {
    for (const [peerId, st] of this.peers) {
      const bg = st.unverified;
      if (bg === undefined || !this.deps.isHost(peerId)) continue;
      st.unverified = undefined;
      void this.onScene(peerId, st, bg);
    }
  }

  private async onScene(peerId: string, st: PeerState, bg: string) {
    if (!this.deps.isHost(peerId)) {
      st.unverified = bg; // anyone can send this; only the host's word counts, so just remember it
      return;
    }
    st.unverified = undefined;
    this.forget(st, "scene");
    st.scene = bg;
    const sha = sceneSha(bg);
    const cached = sha !== null && !!(await this.deps.store.get(sha));
    if (st.scene !== bg) return; // a newer scene arrived while we were checking
    if (sha === null || cached) {
      st.scene = undefined;
      this.deps.onScene(bg);
      return;
    }
    st.wanted.set(sha, "scene");
    await st.channel.send(JSON.stringify({ t: "want", sha }));
  }

  private async onWant(st: PeerState, sha: string) {
    // Only ever serve our own avatar files and the scene we announce, never arbitrary cache contents.
    const ours = (this.mine ? spriteShas(this.mine) : []).includes(sha) || (!!this.myScene && sceneSha(this.myScene) === sha);
    if (!ours) return;
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
    const kind = st.wanted.get(msg.sha);
    if (!kind) return; // unsolicited

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
    const ok =
      (await sha256Hex(bytes)) === msg.sha &&
      (await (kind === "scene" ? this.deps.acceptScene(bytes) : this.deps.accept(bytes)));
    const stillWanted = st.wanted.get(msg.sha) === kind; // a newer announcement may have replaced it
    st.wanted.delete(msg.sha); // success or not, no retry: a bad file stays bad
    if (!ok) return;
    await this.deps.store.put(msg.sha, bytes);

    if (kind === "scene") {
      if (stillWanted && st.scene === msg.sha) {
        st.scene = undefined;
        this.deps.onScene(msg.sha);
      }
      return;
    }
    if (!stillWanted) return;
    if ([...st.wanted.values()].includes("avatar") || !st.spec) return;
    for (const sha of spriteShas(st.spec)) if (!(await this.deps.store.get(sha))) return;
    this.deps.onAvatar(peerId, st.spec);
  }
}
