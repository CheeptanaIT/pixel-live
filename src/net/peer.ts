import type { SignalData } from "../../shared/protocol";
import { getIceServers } from "./ice";

export type LinkState = "connecting" | "connected" | "failed";

type CandidateData = Extract<SignalData, { candidate: unknown }>["candidate"];

/** Opus voice at 32 kbps keeps a 10-person mesh near 300 kbps upload per person. */
const MAX_AUDIO_BITRATE = 32_000;

export interface PeerLinkOptions {
  /** The politer side backs off when both offer at once (glare). */
  polite: boolean;
  /**
   * Only the initiator makes the first offer. If both sides offer at once the polite one has to
   * roll back, and Chrome sometimes never gathers ICE candidates after such a fast rollback,
   * leaving the link stuck in "connecting". Perfect negotiation stays as the safety net.
   */
  initiator: boolean;
  localStream: MediaStream | null;
  send(data: SignalData): void;
  onState(state: LinkState): void;
  /** The remote voice, once its track arrives. */
  onStream(stream: MediaStream): void;
  /** Peer-to-peer data channel: opened, closed, and a text message from the other side. */
  onChannelOpen(): void;
  onChannelClose(): void;
  onControl(text: string): void;
  /** The browser refused to start playback (autoplay policy: no user gesture on the page yet). */
  onPlaybackBlocked(): void;
}

/** Above this much queued data, `sendControl` waits for the buffer to drain. */
const BUFFER_HIGH = 512 * 1024;
const BUFFER_LOW = 64 * 1024;

/** One RTCPeerConnection to one remote peer, using the "perfect negotiation" pattern. */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private readonly channel: RTCDataChannel;
  private readonly audio = new Audio();
  private sender?: RTCRtpSender;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;
  private remoteApplied = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly events: string[] = [];

  constructor(private readonly opts: PeerLinkOptions) {
    const pc = (this.pc = new RTCPeerConnection({ iceServers: getIceServers() }));

    // Both sides create the same pre-agreed channel (negotiated, id 0), so neither has to wait for
    // an "ondatachannel" and there is no race over who opens it.
    const channel = (this.channel = pc.createDataChannel("ctl", { negotiated: true, id: 0, ordered: true }));
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.onopen = () => {
      this.trace("data channel open");
      if (!this.closed) opts.onChannelOpen();
    };
    channel.onclose = () => {
      if (!this.closed) opts.onChannelClose();
    };
    channel.onmessage = (e) => {
      if (typeof e.data === "string") opts.onControl(e.data);
    };

    const track = opts.localStream?.getAudioTracks()[0];
    if (track && opts.localStream) {
      this.sender = pc.addTrack(track, opts.localStream);
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.onnegotiationneeded = async () => {
      if (!opts.initiator && !this.remoteApplied) {
        // Our local tracks get picked up when the initiator's offer arrives.
        this.trace("negotiationneeded (waiting for the initiator's offer)");
        return;
      }
      this.trace("negotiationneeded");
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription();
      } catch (err) {
        this.trace(`negotiation failed: ${err}`);
        console.warn("negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onsignalingstatechange = () => this.trace(`signalingState=${pc.signalingState}`);
    pc.oniceconnectionstatechange = () => this.trace(`iceConnectionState=${pc.iceConnectionState}`);

    pc.onicecandidate = ({ candidate }) => {
      this.trace(candidate ? `local candidate ${candidate.type}` : "local candidates done");
      if (candidate) opts.send({ candidate: candidate.toJSON() as CandidateData });
    };

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      this.audio.srcObject = stream;
      opts.onStream(stream);
      // Joining a room is a click, so this normally succeeds. The OBS page has no click at all:
      // OBS allows autoplay, a plain browser tab does not, and then we need a gesture to resume.
      void this.audio.play().catch(() => opts.onPlaybackBlocked());
    };

    pc.onconnectionstatechange = () => {
      this.trace(`connectionState=${pc.connectionState}`);
      if (this.closed) return;
      switch (pc.connectionState) {
        case "connected":
          opts.onState("connected");
          void this.capBitrate();
          break;
        case "failed":
          opts.onState("failed");
          pc.restartIce(); // re-fires negotiationneeded with fresh ICE credentials
          break;
        case "disconnected":
        case "connecting":
        case "new":
          opts.onState("connecting");
          break;
      }
    };
  }

  /**
   * Signals are processed strictly one at a time. Without this a candidate can reach
   * addIceCandidate while the description it belongs to is still being applied, and be dropped.
   */
  handleSignal(data: SignalData): Promise<void> {
    this.queue = this.queue.then(() => this.process(data));
    return this.queue;
  }

  private async process(data: SignalData) {
    const { pc } = this;
    try {
      if ("description" in data) {
        const offerCollision =
          data.description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !this.opts.polite && offerCollision;
        this.trace(
          `recv ${data.description.type} (signaling=${pc.signalingState}, makingOffer=${this.makingOffer}` +
            `${offerCollision ? ", COLLISION" : ""}${this.ignoreOffer ? ", IGNORED" : ""})`,
        );
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        this.remoteApplied = true;
        if (data.description.type === "offer") {
          await pc.setLocalDescription();
          this.sendDescription();
        }
      } else {
        try {
          await pc.addIceCandidate(data.candidate);
          this.trace("remote candidate added");
        } catch (err) {
          // Candidates that belong to an offer we deliberately ignored are expected to fail.
          this.trace(`remote candidate rejected (ignoreOffer=${this.ignoreOffer}): ${err}`);
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.trace(`signal handling failed: ${err}`);
      console.warn("signal handling failed", err);
    }
  }

  /** Dev-only: a snapshot plus the last negotiation events, for diagnosing stuck links. */
  debug() {
    const { pc } = this;
    return {
      signaling: pc.signalingState,
      ice: pc.iceConnectionState,
      connection: pc.connectionState,
      gathering: pc.iceGatheringState,
      polite: this.opts.polite,
      events: [...this.events],
    };
  }

  private trace(event: string) {
    if (!import.meta.env.DEV) return;
    this.events.push(`${(performance.now() / 1000).toFixed(2)} ${event}`);
    if (this.events.length > 60) this.events.shift();
  }

  /** Retry playback after a user gesture. */
  resumePlayback() {
    if (this.audio.srcObject) void this.audio.play().catch(() => undefined);
  }

  /** Send a text message to this peer, waiting if the channel is backed up. Drops it if closed. */
  async sendControl(text: string): Promise<void> {
    const ch = this.channel;
    if (ch.readyState !== "open") return;
    if (ch.bufferedAmount > BUFFER_HIGH) {
      await new Promise<void>((resolve) => {
        const done = () => {
          ch.removeEventListener("bufferedamountlow", done);
          ch.removeEventListener("close", done);
          resolve();
        };
        ch.addEventListener("bufferedamountlow", done);
        ch.addEventListener("close", done);
      });
    }
    if (ch.readyState === "open") ch.send(text);
  }

  async replaceTrack(track: MediaStreamTrack) {
    await this.sender?.replaceTrack(track);
  }

  async stats(): Promise<{ bytesReceived: number; packetsReceived: number }> {
    let bytesReceived = 0;
    let packetsReceived = 0;
    (await this.pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        bytesReceived += r.bytesReceived ?? 0;
        packetsReceived += r.packetsReceived ?? 0;
      }
    });
    return { bytesReceived, packetsReceived };
  }

  close() {
    this.closed = true;
    this.audio.srcObject = null;
    this.pc.close();
  }

  private sendDescription() {
    const d = this.pc.localDescription;
    this.trace(`send ${d?.type ?? "nothing"} (signaling=${this.pc.signalingState})`);
    if (d && (d.type === "offer" || d.type === "answer")) {
      this.opts.send({ description: { type: d.type, sdp: d.sdp } });
    }
  }

  private async capBitrate() {
    if (!this.sender) return;
    try {
      const params = this.sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = MAX_AUDIO_BITRATE;
      await this.sender.setParameters(params);
    } catch {
      // not fatal: the browser's default audio bitrate is already modest
    }
  }
}
