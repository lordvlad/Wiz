import { describe, expect, test } from "bun:test";
import { openRPCHandler } from "../src/server/openrpc.ts";

class UserService {
  async getUser(params: { id: string }) {
    if (params.id === "404") {
      const err = new Error("User not found");
      (err as any).code = 404;
      throw err;
    }
    return { id: params.id, name: "Alice" };
  }

  async add(a: number, b: number) {
    return a + b;
  }
}

describe("OpenRPC Server Handler", () => {
  const handler = openRPCHandler({
    services: [new UserService()],
    info: { title: "User API", version: "1.0.0" },
  });

  test("HTTP POST single JSON-RPC request", async () => {
    const req = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getUser",
        params: { id: "123" },
      }),
    });

    const res = await handler.fetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toEqual({ id: "123", name: "Alice" });
  });

  test("HTTP POST positional parameters", async () => {
    const req = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "add",
        params: [5, 10],
      }),
    });

    const res = await handler.fetch(req);
    const body = (await res.json()) as any;
    expect(body.result).toBe(15);
  });

  test("HTTP POST error handling", async () => {
    const req = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "getUser",
        params: { id: "404" },
      }),
    });

    const res = await handler.fetch(req);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(404);
    expect(body.error.message).toBe("User not found");
  });

  test("HTTP POST rpc.discover returns OpenRPC document", async () => {
    const req = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "disc",
        method: "rpc.discover",
      }),
    });

    const res = await handler.fetch(req);
    const body = (await res.json()) as any;
    expect(body.result.openrpc).toBe("1.3.0");
    expect(body.result.info.title).toBe("User API");
  });

  test("HTTP OPTIONS CORS preflight", async () => {
    const req = new Request("http://localhost/rpc", { method: "OPTIONS" });
    const res = await handler.fetch(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("HTTP Batch Request", async () => {
    const req = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "add", params: [1, 2] },
        { jsonrpc: "2.0", id: 2, method: "add", params: [3, 4] },
      ]),
    });

    const res = await handler.fetch(req);
    const body = (await res.json()) as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0].result).toBe(3);
    expect(body[1].result).toBe(7);
  });

  test("WebSocket message handler", async () => {
    let sentMessage: string = "";
    const mockWs = {
      send(msg: string) {
        sentMessage = msg;
      },
    };

    await handler.websocket.message(
      mockWs,
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "add", params: [20, 30] })
    );

    const parsed = JSON.parse(sentMessage);
    expect(parsed.id).toBe(10);
    expect(parsed.result).toBe(50);
  });

  test("TCP Socket data handler", async () => {
    let writtenData: string = "";
    const mockSocket = {
      write(msg: string) {
        writtenData += msg;
      },
    };

    await handler.socket.data(
      mockSocket,
      JSON.stringify({ jsonrpc: "2.0", id: 99, method: "add", params: [100, 200] }) + "\n"
    );

    const parsed = JSON.parse(writtenData.trim());
    expect(parsed.id).toBe(99);
    expect(parsed.result).toBe(300);
  });
});
