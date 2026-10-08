import type { EmoteId } from "../../shared/p2p";

/** Each emote is an 8x8 pixel icon: `.` clear, `#` main colour, `o` outline/detail colour. */
export const EMOTE_SIZE = 8;

interface EmoteArt {
  rows: string[];
  main: string;
  detail: string;
}

export const EMOTE_ART: Record<EmoteId, EmoteArt> = {
  1: {
    // heart
    rows: [".##..##.", "########", "########", "########", ".######.", "..####..", "...##...", "........"],
    main: "#ff4d6d",
    detail: "#ffc2d1",
  },
  2: {
    // star
    rows: ["...##...", "...##...", "########", ".######.", "..####..", ".##..##.", ".#....#.", "........"],
    main: "#ffd23f",
    detail: "#fff3b0",
  },
  3: {
    // music note
    rows: ["...#####", "...#...#", "...#...#", "...#..##", ".###..##", "####....", ".##.....", "........"],
    main: "#7cf5c6",
    detail: "#d6fff0",
  },
  4: {
    // laughing face
    rows: [".######.", "#oooooo#", "#o#oo#o#", "#oooooo#", "#o####o#", "#oo##oo#", ".######.", "........"],
    main: "#ffb703",
    detail: "#3b2200",
  },
};

export const EMOTE_LABEL: Record<EmoteId, string> = { 1: "หัวใจ", 2: "ว้าว", 3: "ดนตรี", 4: "ขำ" };
export const EMOTE_GLYPH: Record<EmoteId, string> = { 1: "❤️", 2: "⭐", 3: "🎵", 4: "😆" };

/** One emote as an 8x8 canvas (scaled up by the renderer, never smoothed). */
export function emoteCanvas(id: EmoteId): HTMLCanvasElement {
  const art = EMOTE_ART[id];
  const canvas = document.createElement("canvas");
  canvas.width = EMOTE_SIZE;
  canvas.height = EMOTE_SIZE;
  const ctx = canvas.getContext("2d")!;
  art.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = ch === "o" ? art.detail : art.main;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  return canvas;
}

type Listener = (peerId: string, id: EmoteId) => void;

/** Tells the stage that somebody fired an emote. Tiny pub/sub so the network layer stays out of Pixi. */
export class EmoteBus {
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(peerId: string, id: EmoteId) {
    for (const fn of this.listeners) fn(peerId, id);
  }
}

export const emoteBus = new EmoteBus();
