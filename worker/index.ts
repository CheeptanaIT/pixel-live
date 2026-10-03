import { isValidRoomId } from "../shared/room";

export { RoomDO } from "./room";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    const ws = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (ws) {
      const roomId = ws[1];
      if (!isValidRoomId(roomId)) {
        return new Response("bad room", { status: 400 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }

      // Cloudflare always sets this header in production; it is absent in local dev, where
      // there is nobody to protect against and all test traffic would share one bucket.
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) {
        const { success } = await env.CONNECT_LIMIT.limit({ key: ip });
        if (!success) {
          return new Response("too many connections, slow down", { status: 429, headers: { "Retry-After": "60" } });
        }
      }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
