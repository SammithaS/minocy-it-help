import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";
import type { BoardEvent } from "../lib/tickets";

/**
 * Live feed for the IT console. One instance ("board"); consoles connect over hibernatable
 * WebSockets, so idle connections cost nothing while the object sleeps. Ticket changes are pushed
 * in with the `broadcast()` RPC. Auth happens in the Worker before the upgrade is forwarded here.
 */
export class TicketBoard extends DurableObject<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    // Tag with the user id so a user's tabs can be found later (e.g. targeted notifications).
    const userId = request.headers.get("x-user-id") ?? "unknown";
    this.ctx.acceptWebSocket(server, [userId]);
    server.send(JSON.stringify({ type: "hello", connections: this.ctx.getWebSockets().length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(event: BoardEvent): Promise<number> {
    const message = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        sent++;
      } catch {
        // Socket already closing; the runtime will clean it up.
      }
    }
    return sent;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {
      // already closed
    }
  }
}
