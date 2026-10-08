import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";

async function person(browser: Browser) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  return { ctx, page: await ctx.newPage() };
}

async function createRoomLobby(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill("Mint");
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  return new URL(page.url()).pathname;
}

async function enter(page: Page) {
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
}

const panel = (page: Page) => page.getByTestId("timeline");
const openPanel = (page: Page) => panel(page).locator("summary").click();
const stats = (page: Page) => page.getByTestId("timeline-stats");

test.describe("timeline and bookmarks", () => {
  test("only the host has the panel", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const path = await createRoomLobby(host.page);
    await enter(host.page);
    await expect(panel(host.page)).toBeVisible();

    await guest.page.goto(path);
    await guest.page.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Jay");
    await guest.page.getByRole("button", { name: "เข้าห้อง" }).click();
    await expect(guest.page.getByRole("region", { name: "ผู้เข้าร่วม" })).toBeVisible();
    await expect(panel(guest.page)).toHaveCount(0);
    // pressing B as a guest must not do anything
    await guest.page.locator("body").click({ position: { x: 5, y: 5 } });
    await guest.page.keyboard.press("b");

    await Promise.all([host, guest].map((p) => p.ctx.close()));
  });

  test("bookmarks need the timer, the B key adds one and focuses its note, and typing B in a field does not", async ({ browser }) => {
    const host = await person(browser);
    await createRoomLobby(host.page);
    await enter(host.page);
    await openPanel(host.page);

    await expect(host.page.getByRole("button", { name: /Bookmark \(B\)/ })).toBeDisabled();
    await host.page.locator("body").click({ position: { x: 5, y: 5 } });
    await host.page.keyboard.press("b");
    await expect(host.page.getByTestId("bookmark")).toHaveCount(0); // timer not started

    await host.page.getByRole("button", { name: "▶️ เริ่มจับเวลา" }).click();
    await expect(host.page.getByTestId("timeline-clock")).toBeVisible();

    await host.page.locator("body").click({ position: { x: 5, y: 5 } });
    await host.page.keyboard.press("b");
    await expect(host.page.getByTestId("bookmark")).toHaveCount(1);
    // the cursor is already in the note box: typing "b" goes into the note, not a new bookmark
    await host.page.keyboard.type("big topic");
    await expect(host.page.getByLabel(/โน้ตของ Bookmark/)).toHaveValue("big topic");
    await expect(host.page.getByTestId("bookmark")).toHaveCount(1);

    // the emote keys do not collide with B, and removing works
    await host.page.getByRole("button", { name: /ลบ Bookmark/ }).click();
    await expect(host.page.getByTestId("bookmark")).toHaveCount(0);

    await host.ctx.close();
  });

  test("the B shortcut follows the physical key, so it works on a Thai keyboard layout", async ({ browser }) => {
    const host = await person(browser);
    await createRoomLobby(host.page);
    await enter(host.page);
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "▶️ เริ่มจับเวลา" }).click();
    await host.page.locator("body").click({ position: { x: 5, y: 5 } });
    // what a Thai layout sends for the physical B key: a Thai letter in `key`, KeyB in `code`
    await host.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ิ", code: "KeyB", bubbles: true }));
    });
    await expect(host.page.getByTestId("bookmark")).toHaveCount(1);
    await host.ctx.close();
  });

  test("the speaking log and bookmarks survive a refresh, and 'clear all' needs a second press", async ({ browser }) => {
    const host = await person(browser);
    await createRoomLobby(host.page);
    await enter(host.page);
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "▶️ เริ่มจับเวลา" }).click();
    await host.page.getByRole("button", { name: /Bookmark \(B\)/ }).click();
    await host.page.getByLabel(/โน้ตของ Bookmark/).fill("remember me");
    // the fake microphone beeps, so the host's own voice produces at least one segment
    await expect(stats(host.page)).toContainText(/ช่วงที่มีคนพูด: [1-9]/, { timeout: 20_000 });
    await host.page.waitForTimeout(1300); // let the debounced save land

    await host.page.reload();
    await enter(host.page);
    await openPanel(host.page);
    await expect(host.page.getByTestId("timeline-clock")).toBeVisible();
    await expect(host.page.getByLabel(/โน้ตของ Bookmark/)).toHaveValue("remember me");
    await expect(stats(host.page)).toContainText(/ช่วงที่มีคนพูด: [1-9]/);

    await host.page.getByRole("button", { name: "🗑️ ล้างทั้งหมด" }).click();
    await expect(host.page.getByTestId("bookmark")).toHaveCount(1); // first press only arms it
    await host.page.getByRole("button", { name: /ยืนยันล้างทั้งหมด/ }).click();
    await expect(host.page.getByTestId("bookmark")).toHaveCount(0);
    await expect(host.page.getByRole("button", { name: "▶️ เริ่มจับเวลา" })).toBeVisible();

    await host.ctx.close();
  });

  test("exports a CSV and markers file, and gives valid YouTube chapters only when the rules are met", async ({ browser }) => {
    test.setTimeout(90_000);
    const host = await person(browser);
    await createRoomLobby(host.page);
    await enter(host.page);
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "▶️ เริ่มจับเวลา" }).click();
    await expect(host.page.getByTestId("chapters-hint")).toBeVisible(); // nothing to chapter yet

    // YouTube wants 10 s between chapters, so wait for real
    await host.page.waitForTimeout(11_000);
    await host.page.getByRole("button", { name: /Bookmark \(B\)/ }).click();
    await host.page.getByLabel(/โน้ตของ Bookmark/).fill("หัวข้อแรก");
    await host.page.keyboard.press("Enter");
    await expect(host.page.getByTestId("chapters-hint")).toBeVisible(); // 00:00 + one is still only two

    await host.page.waitForTimeout(11_000);
    await host.page.locator("body").click({ position: { x: 5, y: 5 } });
    await host.page.keyboard.press("b");
    await host.page.keyboard.type("หัวข้อสอง");
    await host.page.keyboard.press("Enter");

    // the last chapter must also last 10 s before the text is valid
    await host.page.waitForTimeout(11_000);
    const chapters = await host.page.getByTestId("chapters").innerText();
    const lines = chapters.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("00:00 เริ่มต้น");
    expect(lines[1]).toMatch(/^00:1[0-2] หัวข้อแรก$/);
    expect(lines[2]).toMatch(/^00:2[1-4] หัวข้อสอง$/);

    const [csvDownload] = await Promise.all([
      host.page.waitForEvent("download"),
      host.page.getByRole("button", { name: /timeline\.csv/ }).click(),
    ]);
    expect(csvDownload.suggestedFilename()).toBe("timeline.csv");
    const csv = await readFile((await csvDownload.path())!, "utf8");
    expect(csv.startsWith("﻿start,end,duration,speaker,type,note\r\n")).toBe(true);
    expect(csv).toContain(",bookmark,หัวข้อแรก");
    expect(csv).toContain(",bookmark,หัวข้อสอง");
    expect(csv).toMatch(/,Mint,speech,/); // the host's own beeping mic

    const [jsonDownload] = await Promise.all([
      host.page.waitForEvent("download"),
      host.page.getByRole("button", { name: /markers\.json/ }).click(),
    ]);
    expect(jsonDownload.suggestedFilename()).toBe("markers.json");
    const markers = JSON.parse(await readFile((await jsonDownload.path())!, "utf8"));
    expect(markers.bookmarks.map((b: { note: string }) => b.note)).toEqual(["หัวข้อแรก", "หัวข้อสอง"]);
    expect(markers.speakers).toContain("Mint");
    expect(markers.durationSeconds).toBeGreaterThan(30);

    await host.ctx.close();
  });
});
