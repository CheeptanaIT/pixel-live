import { describe, expect, it } from "vitest";
import { DEFAULT_GATE, SpeechGate, rmsDb } from "../../src/audio/speech";
import { MAX_SPRITE_SIDE } from "../../shared/p2p";
import { STAGE_H, STAGE_W, computeLayout, fitScale, placeSprite, stageScale } from "../../src/stage/layout";
import { SPRITE_SIZE, buildAvatarFrames, type Grid } from "../../src/stage/procedural";

describe("computeLayout", () => {
  for (let n = 1; n <= 10; n++) {
    it(`${n} people: integer geometry, inside the stage, no overlapping cells`, () => {
      const slots = computeLayout(n);
      expect(slots).toHaveLength(n);

      for (const s of slots) {
        for (const v of [s.x, s.y, s.w, s.h, s.bx, s.by, s.bw, s.bh, s.ly]) expect(Number.isInteger(v)).toBe(true);
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x + s.w).toBeLessThanOrEqual(STAGE_W);
        expect(s.y + s.h).toBeLessThanOrEqual(STAGE_H);
        // the sprite area is inside the cell, and the label fits below it
        expect(s.bx).toBeGreaterThanOrEqual(s.x);
        expect(s.bx + s.bw).toBeLessThanOrEqual(s.x + s.w);
        expect(s.by).toBeGreaterThanOrEqual(s.y);
        expect(s.ly).toBeGreaterThanOrEqual(s.by + s.bh);
        expect(s.ly + 20).toBeLessThanOrEqual(s.y + s.h); // 20 = label canvas height
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = slots[i];
          const b = slots[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `cells ${i} and ${j}`).toBe(false);
        }
      }
    });
  }

  it("uses one row up to 5 people and two rows from 6", () => {
    expect(new Set(computeLayout(5).map((s) => s.y)).size).toBe(1);
    expect(new Set(computeLayout(6).map((s) => s.y)).size).toBe(2);
  });

  it("keeps a lone generated character big but capped, and 10 still readable", () => {
    const solo = fitScale(16, 16, computeLayout(1)[0]);
    const crowd = fitScale(16, 16, computeLayout(10)[0]);
    expect(solo).toBeLessThanOrEqual(10);
    expect(solo).toBeGreaterThan(crowd);
    expect(crowd).toBeGreaterThanOrEqual(5);
  });

  it("centres an incomplete last row", () => {
    const slots = computeLayout(7); // 4 + 3
    const row2 = slots.filter((s) => s.y > 0);
    const left = Math.min(...row2.map((s) => s.x));
    const right = Math.max(...row2.map((s) => s.x + s.w));
    expect(Math.abs(left - (STAGE_W - right))).toBeLessThanOrEqual(1);
  });

  it("returns nothing for an empty room", () => {
    expect(computeLayout(0)).toEqual([]);
  });
});

describe("fitScale / placeSprite with sprites of any size", () => {
  // generated 16x16, typical uploads, the widest and tallest allowed, and odd aspect ratios
  const sprites: [number, number][] = [
    [16, 16],
    [32, 32],
    [48, 64],
    [64, 64],
    [MAX_SPRITE_SIDE, MAX_SPRITE_SIDE],
    [MAX_SPRITE_SIDE, 24],
    [20, MAX_SPRITE_SIDE],
    [1, 1],
  ];

  for (let n = 1; n <= 10; n++) {
    it(`${n} people: every allowed sprite size fits whole-number scaled, with its outline and bounce`, () => {
      for (const slot of computeLayout(n)) {
        for (const [w, h] of sprites) {
          const s = fitScale(w, h, slot);
          expect(Number.isInteger(s) && s >= 1, `${w}x${h} scale ${s}`).toBe(true);
          const { ax, ay } = placeSprite(w, h, s, slot);
          const tag = `${n} people, ${w}x${h} at ${s}x`;
          // sprite plus a one-sprite-pixel outline all round stays inside the slot's sprite area
          expect(ax - s, tag).toBeGreaterThanOrEqual(slot.bx);
          expect(ax + w * s + s, tag).toBeLessThanOrEqual(slot.bx + slot.bw);
          expect(ay + h * s + s, tag).toBeLessThanOrEqual(slot.by + slot.bh);
          // and there is headroom for the bounce (one more sprite pixel up) without leaving the cell
          expect(ay - 2 * s, tag).toBeGreaterThanOrEqual(slot.by);
          // the label starts below everything
          expect(slot.ly, tag).toBeGreaterThanOrEqual(ay + h * s + s);
        }
      }
    });
  }

  it("a 96x96 sprite in the most crowded room still gets scale 1, never a blurry fraction", () => {
    expect(fitScale(MAX_SPRITE_SIDE, MAX_SPRITE_SIDE, computeLayout(10)[0])).toBe(1);
  });

  it("small sprites scale up more than large ones in the same slot", () => {
    const slot = computeLayout(3)[0];
    expect(fitScale(16, 16, slot)).toBeGreaterThan(fitScale(64, 64, slot));
  });
});

describe("stageScale", () => {
  it("uses exactly 3x at 1080p", () => {
    expect(stageScale(1920, 1080)).toBe(3);
    expect(stageScale(1920, 1080, true)).toBe(3);
  });
  it("floors to a whole number when little space is wasted", () => {
    expect(stageScale(1300, 740)).toBe(2); // fit 2.03
  });
  it("accepts a fraction instead of wasting over 30%", () => {
    expect(stageScale(1200, 600)).toBeCloseTo(1.667, 2); // whole=1 would waste 40%
    expect(stageScale(1200, 600, true)).toBe(1);
  });
  it("shrinks below 1 on small screens rather than overflowing", () => {
    expect(stageScale(320, 200)).toBeCloseTo(0.5, 2);
  });
});

const hasPixels = (g: Grid) => g.flat().some((v) => v !== 0);
const diff = (a: Grid, b: Grid) => a.flatMap((row, y) => row.map((v, x) => (v !== b[y][x] ? [x, y] : null))).filter(Boolean) as number[][];

describe("buildAvatarFrames", () => {
  it("is deterministic per seed", () => {
    expect(buildAvatarFrames("mint")).toEqual(buildAvatarFrames("mint"));
  });

  it("gives different seeds different characters", () => {
    const seeds = Array.from({ length: 40 }, (_, i) => JSON.stringify(buildAvatarFrames(`peer-${i}`)));
    expect(new Set(seeds).size).toBeGreaterThan(36);
  });

  it("is always left-right symmetric and fits the sprite size", () => {
    for (let i = 0; i < 60; i++) {
      const f = buildAvatarFrames(`seed-${i}`);
      for (const g of [f.idle, f.talk, f.blink]) {
        expect(g).toHaveLength(SPRITE_SIZE);
        expect(hasPixels(g)).toBe(true);
        g.forEach((row, y) => {
          expect(row).toHaveLength(SPRITE_SIZE);
          row.forEach((v, x) => expect(v, `seed-${i} (${x},${y})`).toBe(row[SPRITE_SIZE - 1 - x]));
        });
      }
    }
  });

  it("changes only the face between frames, and the mouth really differs when talking", () => {
    for (let i = 0; i < 30; i++) {
      const f = buildAvatarFrames(`face-${i}`);
      const mouth = diff(f.idle, f.talk);
      expect(mouth.length).toBeGreaterThan(0);
      for (const [, y] of [...mouth, ...diff(f.idle, f.blink)]) expect(y).toBeGreaterThanOrEqual(5);
      for (const [, y] of [...mouth, ...diff(f.idle, f.blink)]) expect(y).toBeLessThanOrEqual(10);
      expect(diff(f.idle, f.blink).length).toBeGreaterThan(0);
    }
  });

  it("outlines the silhouette without ever clipping it at the sprite edge", () => {
    for (let i = 0; i < 60; i++) {
      const { idle } = buildAvatarFrames(`outline-${i}`);
      expect(idle.flat().includes(1)).toBe(true);
      // Only outline pixels may touch the border; any body pixel there would have lost its outline.
      const last = SPRITE_SIZE - 1;
      idle.forEach((row, y) =>
        row.forEach((v, x) => {
          if (x === 0 || y === 0 || x === last || y === last) expect(v === 0 || v === 1, `outline-${i} (${x},${y})`).toBe(true);
        }),
      );
    }
  });
});

describe("rmsDb", () => {
  it("is -100 for silence and about -3 dBFS for a full-scale sine", () => {
    expect(rmsDb(new Float32Array(512))).toBe(-100);
    const sine = Float32Array.from({ length: 512 }, (_, i) => Math.sin((2 * Math.PI * i * 8) / 512));
    expect(rmsDb(sine)).toBeCloseTo(-3.01, 1);
  });
  it("drops 6 dB when the amplitude halves", () => {
    const loud = Float32Array.from({ length: 512 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * i * 8) / 512));
    const quiet = loud.map((v) => v / 2);
    expect(rmsDb(loud) - rmsDb(quiet)).toBeCloseTo(6.02, 1);
  });
});

describe("SpeechGate", () => {
  const { onDb, offMarginDb, holdMs } = DEFAULT_GATE;

  it("starts speaking in the very same update the level crosses the threshold", () => {
    const g = new SpeechGate();
    expect(g.update(onDb - 1, 0)).toBe(false);
    expect(g.update(onDb + 1, 16)).toBe(true);
  });

  it("does not release during a short pause, and releases after the hold time", () => {
    const g = new SpeechGate();
    g.update(-20, 0);
    expect(g.update(-90, 100)).toBe(true); // pause shorter than holdMs
    expect(g.update(-20, 150)).toBe(true); // resumed in time
    expect(g.update(-90, 150 + holdMs - 1)).toBe(true);
    expect(g.update(-90, 150 + holdMs)).toBe(false);
  });

  it("holds through the hysteresis band instead of flickering", () => {
    const g = new SpeechGate();
    g.update(onDb + 3, 0);
    // just under onDb but above the lower off-threshold: must stay on indefinitely
    for (let t = 16; t < 2000; t += 16) expect(g.update(onDb - offMarginDb / 2, t)).toBe(true);
  });

  it("needs a full onDb crossing to start again, not just the off-threshold", () => {
    const g = new SpeechGate();
    expect(g.update(onDb - offMarginDb / 2, 0)).toBe(false);
  });
});
