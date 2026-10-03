import { CLOSE, type ClientMessage, type Hello, type ServerMessage } from "../../shared/protocol";

export type LinkState = "connecting" | "reconnecting" | "closed";

export interface SignalingHandlers {
  onMessage(msg: ServerMessage): void;
  onState(state: LinkState): void;
}

const MAX_BACKOFF_MS = 8000;

/** WebSocket to the room relay. Reconnects with jittered backoff, except on final close codes. */
export class Signaling {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly roomId: string,
    /** Called on every (re)connect so the hello always reflects current state. */
    private readonly makeHello: () => Hello,
    private readonly handlers: SignalingHandlers,
  ) {}

  start() {
    this.open();
  }

  send(msg: ClientMessage | { t: "signal"; to: string; data: unknown }) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000);
  }

  private open() {
    this.handlers.onState(this.attempt === 0 ? "connecting" : "reconnecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/${this.roomId}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify(this.makeHello()));
    };
    ws.onmessage = (e) => {
      try {
        this.handlers.onMessage(JSON.parse(e.data as string) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (e) => {
      if (this.stopped || this.ws !== ws) return;
      if (e.code >= CLOSE.REPLACED) {
        this.handlers.onState("closed");
        return;
      }
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
      this.attempt++;
      this.handlers.onState("reconnecting");
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}
