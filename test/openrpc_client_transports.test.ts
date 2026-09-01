import { describe, expect, test } from "bun:test";
import { openRPCHandler } from "../src/server/openrpc.ts";
import {
  openRpcClient,
  httpTransport,
  webSocketTransport,
  tcpTransport,
  type OpenRpcCall,
  type OpenRpcResult,
} from "../src/transports/openrpc.ts";

class CalculatorService {
  async multiply(params: { a: number; b: number }) {
    return params.a * params.b;
  }

  async divide(a: number, b: number) {
    if (b === 0) {
      const err = new Error("Division by zero");
      (err as any).code = -32000;
      throw err;
    }
    return a / b;
  }
}

describe("OpenRPC Client & Transports", () => {
  const handler = openRPCHandler({
    services: [new CalculatorService()],
  });

  test("openRpcClient over HTTP transport", async () => {
    const transport = httpTransport({
      fetch: async (url, init) => handler.fetch(new Request(url, init)),
    });

    interface CalculatorClient {
      CalculatorService: {
        multiply(params: { a: number; b: number }): Promise<number>;
        divide(a: number, b: number): Promise<number>;
      };
      multiply(params: { a: number; b: number }): Promise<number>;
    }

    const client = openRpcClient<CalculatorClient>({ transport });

    const prod = await client.CalculatorService.multiply({ a: 6, b: 7 });
    expect(prod).toBe(42);

    const div = await client.CalculatorService.divide(20, 4);
    expect(div).toBe(5);

    const directProd = await client.multiply({ a: 3, b: 4 });
    expect(directProd).toBe(12);
  });

  test("openRpcClient over WebSocket transport (mock)", async () => {
    let wsOnMessage: ((ev: { data: string }) => void) | undefined;
    const mockWs = {
      readyState: 1,
      send: async (msg: string) => {
        await handler.websocket.message(
          {
            send: (reply: string) => {
              if (wsOnMessage) wsOnMessage({ data: reply });
            },
          },
          msg
        );
      },
      onmessage: null as any,
    };

    Object.defineProperty(mockWs, "onmessage", {
      set(fn) {
        wsOnMessage = fn;
      },
      get() {
        return wsOnMessage;
      },
    });

    const transport = webSocketTransport({ url: "ws://localhost", ws: mockWs });
    const client = openRpcClient<{ multiply(params: { a: number; b: number }): Promise<number> }>({
      transport,
    });

    const res = await client.multiply({ a: 5, b: 5 });
    expect(res).toBe(25);
  });

  test("openRpcClient over TCP transport (mock socket)", async () => {
    let socketDataListener: ((data: Uint8Array) => void) | undefined;

    const mockSocket = {
      on(event: string, fn: any) {
        if (event === "data") socketDataListener = fn;
      },
      write: async (dataStr: string) => {
        await handler.socket.data(
          {
            write: (replyStr: string) => {
              if (socketDataListener) {
                socketDataListener(new TextEncoder().encode(replyStr));
              }
            },
          },
          dataStr
        );
      },
    };

    const transport = tcpTransport({ socket: mockSocket });
    const client = openRpcClient<{ multiply(params: { a: number; b: number }): Promise<number> }>({
      transport,
    });

    const res = await client.multiply({ a: 4, b: 8 });
    expect(res).toBe(32);
  });

  test("openRpcClient with interceptors", async () => {
    const traceIds: string[] = [];

    const traceInterceptor = async (
      call: OpenRpcCall,
      next: (req: OpenRpcCall) => Promise<OpenRpcResult>
    ) => {
      call.meta = { ...call.meta, "x-trace-id": "trace-123" };
      traceIds.push("trace-123");
      return await next(call);
    };

    const transport = httpTransport({
      fetch: async (url, init) => handler.fetch(new Request(url, init)),
    });

    const client = openRpcClient<{ multiply(params: { a: number; b: number }): Promise<number> }>({
      transport,
      interceptors: [traceInterceptor],
    });

    const res = await client.multiply({ a: 9, b: 9 });
    expect(res).toBe(81);
    expect(traceIds).toEqual(["trace-123"]);
  });

  test("openRpcClient handles error response", async () => {
    const transport = httpTransport({
      fetch: async (url, init) => handler.fetch(new Request(url, init)),
    });

    const client = openRpcClient<{ divide(a: number, b: number): Promise<number> }>({
      transport,
    });

    try {
      await client.divide(10, 0);
      expect.unreachable("Should have thrown error");
    } catch (err: any) {
      expect(err.message).toBe("Division by zero");
      expect(err.code).toBe(-32000);
    }
  });
});
