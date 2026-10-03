import * as v from "valibot";
import { SignalData, type Peer } from "../../shared/protocol";
import { PeerLink, type LinkState } from "./peer";

export interface MeshCallbacks {
  send(to: string, data: SignalData): void;
  onLinkState(peerId: string, state: LinkState | null): void;
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
      }),
    );
    this.cb.onLinkState(id, "connecting");
  }

  disconnect(peerId: string) {
    const link = this.links.get(peerId);
    if (!link) return;
    link.close();
    this.links.delete(peerId);
    this.cb.onLinkState(peerId, null);
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
