import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAudioFlowing, trackPeerConnections } from "./helpers/pc";

async function person(browser: Browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(trackPeerConnections);
  return { ctx, page: await ctx.newPage() };
}

async function createRoom(page: Page, name: string) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill(name);
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
  return new URL(page.url()).pathname;
}

async function join(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.getByRole("textbox").fill(name);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toContainText(name);
}

const link = (page: Page, peer: string) => page.locator(`[data-testid="link"][data-peer="${peer}"]`);

test("two people hear each other (audio packets flow both ways)", async ({ browser }) => {
  const a = await person(browser);
  const b = await person(browser);

  const path = await createRoom(a.page, "Mint");
  await join(b.page, path, "Jay");

  await expect(link(a.page, "Jay")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect(link(b.page, "Mint")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expectAudioFlowing(a.page, 1);
  await expectAudioFlowing(b.page, 1);

  await a.ctx.close();
  await b.ctx.close();
});

test("six people form a full mesh and everyone receives everyone", async ({ browser }) => {
  test.setTimeout(90_000);
  const names = ["P1", "P2", "P3", "P4", "P5", "P6"];
  const people = await Promise.all(names.map(() => person(browser)));

  const path = await createRoom(people[0].page, names[0]);
  for (let i = 1; i < people.length; i++) await join(people[i].page, path, names[i]);

  for (const [i, p] of people.entries()) {
    for (const other of names.filter((_, j) => j !== i)) {
      await expect(link(p.page, other)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
    }
    await expectAudioFlowing(p.page, names.length - 1);
  }

  await Promise.all(people.map((p) => p.ctx.close()));
});

test("leaving and rejoining restores audio", async ({ browser }) => {
  const a = await person(browser);
  const b = await person(browser);
  const path = await createRoom(a.page, "Mint");
  await join(b.page, path, "Jay");
  await expect(link(a.page, "Jay")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });

  await b.page.goto("/"); // leave
  await expect(link(a.page, "Jay")).toHaveCount(0);

  await join(b.page, path, "Jay");
  await expect(link(a.page, "Jay")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expectAudioFlowing(a.page, 1);
  await expectAudioFlowing(b.page, 1);

  await a.ctx.close();
  await b.ctx.close();
});

test("refreshing rebuilds the audio link on both sides", async ({ browser }) => {
  const a = await person(browser);
  const b = await person(browser);
  const path = await createRoom(a.page, "Mint");
  await join(b.page, path, "Jay");
  await expect(link(a.page, "Jay")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });

  await b.page.reload();
  await b.page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(link(b.page, "Mint")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect(link(a.page, "Jay")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expectAudioFlowing(a.page, 1);

  await a.ctx.close();
  await b.ctx.close();
});

test("mute silences the sender without dropping the connection", async ({ browser }) => {
  const a = await person(browser);
  const b = await person(browser);
  const path = await createRoom(a.page, "Mint");
  await join(b.page, path, "Jay");
  await expect(link(b.page, "Mint")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });

  await a.page.getByRole("button", { name: /เปิดไมค์อยู่/ }).click();
  await expect(a.page.getByRole("button", { name: /ปิดไมค์อยู่/ })).toHaveAttribute("aria-pressed", "true");
  await expect(link(b.page, "Mint")).toHaveAttribute("data-state", "connected");

  await a.ctx.close();
  await b.ctx.close();
});

test("a denied microphone explains how to fix it and offers listen-only", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: [] });
  const page = await ctx.newPage();
  // Simulate the browser refusing: getUserMedia rejects like a user who clicked "Block".
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("blocked", "NotAllowedError"));
  });
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill("Quiet");
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.getByRole("button", { name: "เข้าห้อง" }).click();

  await expect(page.getByRole("alert")).toContainText("ไม่อนุญาตให้ใช้ไมค์");
  await page.getByRole("button", { name: /เข้าแบบฟังอย่างเดียว/ }).click();
  await expect(page.getByText("โหมดฟังอย่างเดียว")).toBeVisible();
  await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toContainText("Quiet");
  await ctx.close();
});
