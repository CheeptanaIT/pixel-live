import { describe, expect, it } from "vitest";
import {
  buildSegments,
  closeDangling,
  formatClock,
  mergeSegments,
  speechSegments,
  timelineRows,
  toCsv,
  toMarkersJson,
  youtubeChapters,
  type Bookmark,
  type SpeakEvent,
  type TimelineInput,
} from "../../src/timeline/timeline";

const T0 = 1_000_000;
const on = (peerId: string, s: number): SpeakEvent => ({ peerId, speaking: true, at: T0 + s * 1000 });
const off = (peerId: string, s: number): SpeakEvent => ({ peerId, speaking: false, at: T0 + s * 1000 });
const mark = (s: number, note = ""): Bookmark => ({ id: `b${s}`, at: T0 + s * 1000, note });

function input(over: Partial<TimelineInput> = {}): TimelineInput {
  return { events: [], bookmarks: [], names: { a: "Mint", b: "Jay" }, t0: T0, endAt: T0 + 60_000, ...over };
}

describe("buildSegments", () => {
  it("pairs start and stop per person, relative to t0", () => {
    const segs = buildSegments([on("a", 1), off("a", 3), on("b", 2), off("b", 5)], T0, T0 + 60_000);
    expect(segs).toEqual([
      { peerId: "a", start: 1000, end: 3000 },
      { peerId: "b", start: 2000, end: 5000 },
    ]);
  });

  it("keeps people independent when they talk over each other", () => {
    const segs = buildSegments([on("a", 0), on("b", 1), off("a", 4), off("b", 2)], T0, T0 + 10_000);
    expect(segs.find((s) => s.peerId === "a")).toEqual({ peerId: "a", start: 0, end: 4000 });
    expect(segs.find((s) => s.peerId === "b")).toEqual({ peerId: "b", start: 1000, end: 2000 });
  });

  it("closes someone still talking at the end", () => {
    expect(buildSegments([on("a", 5)], T0, T0 + 9000)).toEqual([{ peerId: "a", start: 5000, end: 9000 }]);
  });

  it("clips what happened before t0 and drops what ended before it", () => {
    const segs = buildSegments([on("a", -5), off("a", 2), on("b", -9), off("b", -3)], T0, T0 + 10_000);
    expect(segs).toEqual([{ peerId: "a", start: 0, end: 2000 }]);
  });

  it("ignores a stop with no start and a repeated start", () => {
    const segs = buildSegments([off("a", 1), on("a", 2), on("a", 3), off("a", 4)], T0, T0 + 10_000);
    expect(segs).toEqual([{ peerId: "a", start: 2000, end: 4000 }]);
  });

  it("does not depend on the order events were logged in", () => {
    const a = buildSegments([off("a", 3), on("a", 1)], T0, T0 + 10_000);
    expect(a).toEqual([{ peerId: "a", start: 1000, end: 3000 }]);
  });
});

describe("mergeSegments", () => {
  const seg = (peerId: string, start: number, end: number) => ({ peerId, start, end });

  it("joins one person's segments less than 1.5 s apart", () => {
    expect(mergeSegments([seg("a", 0, 2000), seg("a", 3000, 5000)])).toEqual([seg("a", 0, 5000)]);
  });

  it("keeps a gap of 1.5 s or more", () => {
    expect(mergeSegments([seg("a", 0, 2000), seg("a", 3500, 5000)])).toHaveLength(2);
  });

  it("never joins different people", () => {
    expect(mergeSegments([seg("a", 0, 2000), seg("b", 2100, 4000)])).toHaveLength(2);
  });

  it("drops segments shorter than 0.5 s, but only after merging", () => {
    expect(mergeSegments([seg("a", 0, 300)])).toEqual([]);
    expect(mergeSegments([seg("a", 0, 300), seg("a", 600, 900)])).toEqual([seg("a", 0, 900)]);
    expect(mergeSegments([seg("a", 0, 500)])).toEqual([seg("a", 0, 500)]);
  });

  it("returns results ordered by start time", () => {
    const out = mergeSegments([seg("b", 5000, 7000), seg("a", 0, 2000)]);
    expect(out.map((s) => s.peerId)).toEqual(["a", "b"]);
  });
});

describe("CSV", () => {
  it("has the agreed columns, Excel-friendly encoding and one row per segment and bookmark", () => {
    const rows = timelineRows(input({ events: [on("a", 1), off("a", 4)], bookmarks: [mark(2, "ช่วงสำคัญ")] }));
    const lines = toCsv(rows).split("\r\n");
    expect(lines).toEqual([
      "﻿start,end,duration,speaker,type,note",
      "1.000,4.000,3.000,Mint,speech,",
      "2.000,2.000,0.000,,bookmark,ช่วงสำคัญ",
      "",
    ]);
  });

  it("quotes commas, quotes and newlines", () => {
    const csv = toCsv(timelineRows(input({ bookmarks: [mark(1, 'say "hi", ok\nbye')] })));
    expect(csv).toContain('"say ""hi"", ok\nbye"');
  });

  it("neutralises spreadsheet formulas in names and notes", () => {
    const csv = toCsv(
      timelineRows(input({ names: { a: "=HYPERLINK(1)" }, events: [on("a", 0), off("a", 2)], bookmarks: [mark(1, "+cmd")] })),
    );
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("'+cmd");
  });

  it("ignores bookmarks outside the recording", () => {
    const rows = timelineRows(input({ bookmarks: [mark(-5, "before"), mark(30, "inside"), mark(90, "after")] }));
    expect(rows.map((r) => r.note)).toEqual(["inside"]);
  });

  it("has only the header when nothing happened", () => {
    expect(toCsv(timelineRows(input()))).toBe("﻿start,end,duration,speaker,type,note\r\n");
  });
});

describe("markers.json", () => {
  it("lists speakers, bookmarks and segments in seconds", () => {
    const json = JSON.parse(
      toMarkersJson(input({ events: [on("a", 1), off("a", 4)], bookmarks: [mark(2, "x")], endAt: T0 + 90_000 })),
    );
    expect(json.version).toBe(1);
    expect(json.durationSeconds).toBe(90);
    expect(json.startedAt).toBe(new Date(T0).toISOString());
    expect(json.speakers).toEqual(["Mint"]);
    expect(json.bookmarks).toEqual([{ time: 2, note: "x" }]);
    expect(json.segments).toEqual([{ start: 1, end: 4, speaker: "Mint" }]);
  });
});

describe("formatClock", () => {
  it("uses mm:ss under an hour and h:mm:ss after", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65_900)).toBe("01:05");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("youtubeChapters", () => {
  it("starts at 00:00 even when the first bookmark is later", () => {
    const r = youtubeChapters(input({ bookmarks: [mark(20, "หัวข้อ A"), mark(40, "หัวข้อ B")], endAt: T0 + 70_000 }));
    expect(r).toMatchObject({ ok: true, count: 3, skipped: 0 });
    if (r.ok) expect(r.text).toBe("00:00 เริ่มต้น\n00:20 หัวข้อ A\n00:40 หัวข้อ B");
  });

  it("names the opening chapter after a noted bookmark made in the first 10 s, whatever the exact second", () => {
    for (const at of [0.4, 1.2, 9]) {
      const r = youtubeChapters(input({ bookmarks: [mark(at, "Intro"), mark(15, "B"), mark(30, "C")], endAt: T0 + 60_000 }));
      if (!r.ok) throw new Error("expected chapters");
      expect(r.text.split("\n")[0]).toBe("00:00 Intro");
      expect(r.count).toBe(3);
    }
  });

  it("keeps the default opener when the early bookmark has no note, and skips it", () => {
    const r = youtubeChapters(input({ bookmarks: [mark(1), mark(15, "B"), mark(30, "C")], endAt: T0 + 60_000 }));
    if (!r.ok) throw new Error("expected chapters");
    expect(r.text.split("\n")[0]).toBe("00:00 เริ่มต้น");
    expect(r).toMatchObject({ count: 3, skipped: 1 });
  });

  it("fails with fewer than three chapters", () => {
    expect(youtubeChapters(input({ bookmarks: [mark(20)] }))).toEqual({ ok: false, reason: "tooFew", have: 2 });
    expect(youtubeChapters(input())).toEqual({ ok: false, reason: "tooFew", have: 1 });
  });

  it("skips a bookmark closer than 10 s to the previous chapter, and says so", () => {
    const r = youtubeChapters(input({ bookmarks: [mark(20), mark(25), mark(40)], endAt: T0 + 80_000 }));
    expect(r).toMatchObject({ ok: true, count: 3, skipped: 1 });
  });

  it("drops a last chapter shorter than 10 s", () => {
    const r = youtubeChapters(input({ bookmarks: [mark(20), mark(40), mark(55)], endAt: T0 + 60_000 }));
    expect(r).toMatchObject({ ok: true, count: 3, skipped: 1 });
    if (r.ok) expect(r.text).not.toContain("00:55");
  });

  it("fails when dropping the short last chapter leaves too few", () => {
    expect(youtubeChapters(input({ bookmarks: [mark(20), mark(55)], endAt: T0 + 60_000 }))).toMatchObject({ ok: false });
  });

  it("falls back to numbered titles and flattens whitespace", () => {
    const r = youtubeChapters(input({ bookmarks: [mark(20, "  "), mark(40, "two\n lines")], endAt: T0 + 70_000 }));
    if (!r.ok) throw new Error("expected chapters");
    expect(r.text.split("\n")).toEqual(["00:00 เริ่มต้น", "00:20 บทที่ 2", "00:40 two lines"]);
  });

  it("switches to h:mm:ss for chapters past one hour", () => {
    const r = youtubeChapters(input({ bookmarks: [mark(1200), mark(3700)], endAt: T0 + 4_000_000 }));
    if (!r.ok) throw new Error("expected chapters");
    expect(r.text.split("\n").map((l) => l.split(" ")[0])).toEqual(["00:00", "20:00", "1:01:40"]);
  });
});

describe("speechSegments", () => {
  it("applies merging and the minimum length to a realistic log", () => {
    const events = [
      on("a", 1), off("a", 2), on("a", 3), off("a", 5), // one turn with a short pause
      on("b", 8), off("b", 8.2), // a cough
      on("b", 10), off("b", 12),
    ];
    expect(speechSegments(input({ events }))).toEqual([
      { peerId: "a", start: 1000, end: 5000 },
      { peerId: "b", start: 10_000, end: 12_000 },
    ]);
  });
});

describe("closeDangling", () => {
  it("ends only the people whose last event is a start", () => {
    const ev = [on("a", 1), off("a", 2), on("b", 3), on("a", 4)];
    const closed = closeDangling(ev, T0 + 9000);
    expect(closed).toHaveLength(2);
    expect(closed).toEqual(
      expect.arrayContaining([
        { peerId: "b", speaking: false, at: T0 + 9000 },
        { peerId: "a", speaking: false, at: T0 + 9000 },
      ]),
    );
  });

  it("never ends someone before they started", () => {
    expect(closeDangling([on("a", 8)], T0 + 1000)).toEqual([{ peerId: "a", speaking: false, at: T0 + 8000 }]);
  });

  it("fixes the bogus long segment a missing stop would cause", () => {
    const ev = [on("a", 1)];
    const fixed = [...ev, ...closeDangling(ev, T0 + 3000)];
    expect(buildSegments(fixed, T0, T0 + 3_600_000)).toEqual([{ peerId: "a", start: 1000, end: 3000 }]);
  });
});
