import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * UserHub —— 每个用户一个实例（单用户场景固定 name="owner"）。
 * 职责：
 *  1. 维护前台 WebSocket 连接（用 Hibernation API，空闲不计费）。
 *  2. 收到新消息时向所有在线连接实时扇出。
 *  3. （M4）离线时触发 Web Push。
 */
export class UserHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // Hibernation：交给运行时托管，DO 可在空闲时被驱逐而不断连
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  /** 由主 Worker 在新消息落库后通过 RPC 调用 */
  async broadcast(payload: unknown): Promise<number> {
    const msg = JSON.stringify({ type: "message", data: payload });
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // 忽略已断开的连接
      }
    }
    // TODO(M4): 若 sockets.length === 0，触发 Web Push 离线推送
    return sockets.length;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // 前台心跳
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, _clean: boolean): void {
    try {
      ws.close(code, "closing");
    } catch {
      /* noop */
    }
  }
}
