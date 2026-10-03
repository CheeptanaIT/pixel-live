import { expect, test, type Browser, type Page } from "@playwright/test";

/** Each person is their own browser context: separate storage, like separate machines. */
async function person(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

async function createRoomAs(page: Page, name: string) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill(name);
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
  return new URL(page.url()).pathname;
}

async function joinAs(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.getByRole("textbox").fill(name);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
}

const roster = (page: Page) => page.getByRole("region", { name: "ผู้เข้าร่วม" });

test("host and guest see each other live, and a refresh rejoins the same room", async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);

  const path = await createRoomAs(host.page, "Mint");
  await expect(roster(host.page)).toContainText("ในห้อง 1/10");

  await joinAs(guest.page, path, "Jay");
  await expect(roster(guest.page)).toContainText("Mint");
  await expect(roster(guest.page)).toContainText("Jay");
  await expect(roster(host.page)).toContainText("Jay");
  await expect(roster(host.page)).toContainText("ในห้อง 2/10");
  // Only the host gets kick buttons and the lock toggle
  await expect(guest.page.getByRole("button", { name: /เชิญ .* ออก/ })).toHaveCount(0);
  await expect(guest.page.getByText("ล็อกห้อง")).toHaveCount(0);

  // Guest refreshes: lobby again, rejoins, host still sees exactly one Jay
  await guest.page.reload();
  await guest.page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(roster(guest.page)).toContainText("Mint");
  await expect(roster(host.page).getByText("Jay")).toHaveCount(1);

  // Guest leaves: host's roster updates
  await guest.page.goto("/");
  await expect(roster(host.page)).not.toContainText("Jay");

  await host.ctx.close();
  await guest.ctx.close();
});

test("host can lock the room, kick a guest, and the guest is told why", async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const late = await person(browser);

  const path = await createRoomAs(host.page, "Mint");
  await joinAs(guest.page, path, "Jay");
  await expect(roster(host.page)).toContainText("Jay");

  await host.page.getByRole("button", { name: /ล็อกห้อง/ }).click();
  await expect(host.page.getByText("ห้องล็อกอยู่")).toBeVisible();
  await joinAs(late.page, path, "Late");
  await expect(late.page.getByText("ห้องนี้ถูกล็อกโดย Host")).toBeVisible();

  await host.page.getByRole("button", { name: "เชิญ Jay ออก" }).click();
  await expect(guest.page.getByText("คุณถูก Host เชิญออกจากห้อง")).toBeVisible();
  await expect(roster(host.page)).not.toContainText("Jay");

  await host.ctx.close();
  await guest.ctx.close();
  await late.ctx.close();
});

test("two tabs of the same browser are two separate peers", async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const path = await createRoomAs(a, "Mint");
  await expect(roster(a)).toContainText("ในห้อง 1/10");

  // Same localStorage (host key) but sessionStorage, and so peerId, is per tab.
  const b = await ctx.newPage();
  await joinAs(b, path, "Mint2");
  await expect(roster(a)).toContainText("Mint2");
  await expect(roster(b)).toContainText("ในห้อง 2/10");
  await ctx.close();
});

test("a malformed room link shows a friendly error", async ({ page }) => {
  await page.goto("/r/not-a-room");
  await expect(page.getByText("ลิงก์ห้องไม่ถูกต้อง")).toBeVisible();
});
