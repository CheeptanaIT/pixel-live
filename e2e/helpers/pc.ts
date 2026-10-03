import { expect, type Page } from "@playwright/test";

/**
 * Records every RTCPeerConnection the page creates, so tests can read real RTP statistics from a
 * dev server *and* from the deployed site, without the app exposing any debug hook in production.
 * Pass to `context.addInitScript`.
 */
export function trackPeerConnections() {
  const Original = window.RTCPeerConnection;
  const created: RTCPeerConnection[] = [];
  (window as unknown as { __testPcs: RTCPeerConnection[] }).__testPcs = created;
  window.RTCPeerConnection = class extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      created.push(this);
    }
  };
}

/** Real RTP, not just a "connected" flag: audio packets must be arriving from `expected` peers. */
export async function expectAudioFlowing(page: Page, expected: number) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const pcs = (window as unknown as { __testPcs?: RTCPeerConnection[] }).__testPcs ?? [];
          let flowing = 0;
          for (const pc of pcs) {
            if (pc.connectionState === "closed") continue;
            let packets = 0;
            (await pc.getStats()).forEach((r) => {
              if (r.type === "inbound-rtp" && r.kind === "audio") packets += r.packetsReceived ?? 0;
            });
            if (packets > 20) flowing++;
          }
          return flowing;
        }),
      { timeout: 20_000, message: "audio packets should arrive from every other peer" },
    )
    .toBe(expected);
}
