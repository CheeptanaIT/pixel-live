import * as v from "valibot";
import { SignalData, type Peer } from "../../shared/protocol";
import { PeerLink, type LinkState } from "./peer";

export interface MeshCallbacks {
  send(to: string, data: SignalData): void;
  onLinkState(peerId: string, state: LinkState | null): void;
  onStream(peerId: string, stream: MediaStream): void;
  onChannelOpen(peerId: string): void;
  onChannelClose(peerId: string): void;
  onControl(peerId: string, text: string): void;
  onPlaybackBlocked(): void;
}

/** Full-mesh of PeerLinks, one per other peer in the room. */
export class Mesh {
  private readonly links = new Map<string, PeerLink>();

  constructor(
    private readonly selfId: string,
    private localStream: MediaStream | null,
    private readonly cb: MeshCallbacks,
  ) {}

  /**
   * `initiator` is true for the side that just arrived (it got the welcome listing this peer)
   * and false for the side that was already here (it got a join). That way exactly one side
   * makes the first offer.
   */
  connect(peer: Peer, initiator: boolean) {
    if (peer.peerId === this.selfId || this.links.has(peer.peerId)) return;
    const id = peer.peerId;
    this.links.set(
      id,
      new PeerLink({
        polite: this.selfId < id,
        initiator,
        localStream: this.localStream,
        send: (data) => this.cb.send(id, data),
        onState: (state) => this.cb.onLinkState(id, state),
        onStream: (stream) => this.cb.onStream(id, stream),
        onChannelOpen: () => this.cb.onChannelOpen(id),
        onChannelClose: () => this.cb.onChannelClose(id),
        onControl: (text) => this.cb.onControl(id, text),
        onPlaybackBlocked: () => this.cb.onPlaybackBlocked(),
      }),
    );
    this.cb.onLinkState(id, "connecting");
  }

  disconnect(peerId: string) {
    const link = this.links.get(peerId);
    if (!link) return;
    link.close();
    this.links.delete(peerId);
    this.cb.onChannelClose(peerId);
    this.cb.onLinkState(peerId, null);
  }

  /** After a user gesture: start any playback the browser held back. */
  resumePlayback() {
    for (const link of this.links.values()) link.resumePlayback();
  }

  /** Text message to one peer over the data channel (no-op if it is not open). */
  sendControl(peerId: string, text: string): Promise<void> {
    return this.links.get(peerId)?.sendControl(text) ?? Promise.resolve();
  }

  /** Same text to everyone whose data channel is open (each send is a no-op otherwise). */
  broadcastControl(text: string) {
    for (const link of this.links.values()) void link.sendControl(text).catch(() => undefined);
  }

  /**
   * Rebuild every link (used on each welcome). After our own reconnect the server told everyone
   * we left and rejoined, so they dropped their end and our old connections are dead.
   */
  reset(peers: Peer[]) {
    this.close();
    for (const p of peers) this.connect(p, true);
  }

  handleSignal(from: string, raw: unknown) {
    const parsed = v.safeParse(SignalData, raw);
    if (!parsed.success) return;
    void this.links.get(from)?.handleSignal(parsed.output);
  }

  async replaceTrack(stream: MediaStream | null) {
    this.localStream = stream;
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    await Promise.all([...this.links.values()].map((l) => l.replaceTrack(track)));
  }

  async stats() {
    const out: Record<string, { bytesReceived: number; packetsReceived: number }> = {};
    for (const [id, link] of this.links) out[id] = await link.stats();
    return out;
  }

  /** Dev-only: per-peer connection snapshot plus recent negotiation events. */
  debug() {
    return Object.fromEntries([...this.links].map(([id, link]) => [id, link.debug()]));
  }

  close() {
    for (const id of [...this.links.keys()]) this.disconnect(id);
  }
}
