export type JsonRpcId = string | number | null;
export type JsonRpcParams = unknown[] | Record<string, unknown>;

export interface WebSocketLike {
  send?(data: string | Uint8Array): void;
}

export interface SocketLike {
  write?(data: string | Uint8Array): void;
}

export type RpcMethodFunction = (...args: unknown[]) => unknown;

export interface OpenRpcHandlerOptions {
  services?: unknown[] | Record<string, unknown>;
  methods?: Record<string, RpcMethodFunction>;
  info?: { title?: string; version?: string; description?: string };
  doc?: Record<string, unknown>;
}

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: JsonRpcId;
  method: string;
  params?: JsonRpcParams;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface OpenRpcHandler {
  fetch(req: Request): Promise<Response>;
  websocket: {
    open(ws: WebSocketLike): void;
    message(ws: WebSocketLike, msg: string | Uint8Array | ArrayBuffer): Promise<void>;
    close(ws: WebSocketLike): void;
  };
  socket: {
    open(socket: SocketLike): void;
    data(socket: SocketLike, buf: Uint8Array | string): Promise<void>;
    close(socket: SocketLike): void;
  };
  handleRequest(request: unknown): Promise<unknown>;
}
function safeJsonStringify(val: unknown): string {
  return JSON.stringify(val, (_k, v) => (typeof v === "bigint" ? String(v) : v));
}

export function openRPCHandler(options: OpenRpcHandlerOptions): OpenRpcHandler {
  // Dynamic service method registration table
  const methodTable = new Map<string, { fn: RpcMethodFunction; target: unknown }>();

  function registerMethod(name: string, fn: RpcMethodFunction, target: unknown) {
    methodTable.set(name, { fn, target });
  }

  // Register methods from options.methods
  if (options.methods) {
    for (const [name, fn] of Object.entries(options.methods)) {
      if (typeof fn === "function") {
        registerMethod(name, fn, options.methods);
      }
    }
  }

  // Register methods from options.services
  if (options.services) {
    const servicesList: Array<{ name?: string; instance: Record<string, unknown> }> = [];

    if (Array.isArray(options.services)) {
      for (const item of options.services) {
        if (item && typeof item === "object") {
          const name = item.constructor && item.constructor.name !== "Object"
            ? item.constructor.name
            : undefined;
          servicesList.push({ name, instance: item as Record<string, unknown> });
        }
      }
    } else if (typeof options.services === "object") {
      for (const [key, item] of Object.entries(options.services)) {
        if (item && typeof item === "object") {
          servicesList.push({ name: key, instance: item as Record<string, unknown> });
        }
      }
    }

    for (const { name: serviceName, instance } of servicesList) {
      const keys = new Set<string>();

      // Object properties
      for (const key of Object.keys(instance)) {
        if (typeof instance[key] === "function") keys.add(key);
      }

      // Prototype methods
      let proto = Object.getPrototypeOf(instance);
      while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key !== "constructor" && typeof instance[key] === "function") {
            keys.add(key);
          }
        }
        proto = Object.getPrototypeOf(proto);
      }

      for (const methodName of keys) {
        const member = instance[methodName];
        if (typeof member === "function") {
          const fn = (member as RpcMethodFunction).bind(instance);
          if (serviceName) {
            registerMethod(`${serviceName}.${methodName}`, fn, instance);
          }
          registerMethod(methodName, fn, instance);
        }
      }
    }
  }

  // OpenRPC 1.3 discovery document
  const openRpcDoc = options.doc ?? {
    openrpc: "1.3.0",
    info: {
      title: options.info?.title ?? "OpenRPC API",
      version: options.info?.version ?? "1.0.0",
      ...(options.info?.description ? { description: options.info.description } : {}),
    },
    methods: Array.from(methodTable.keys()).map((name) => ({
      name,
      params: [],
      result: { name: "result", schema: { type: "object" } },
    })),
  };

  // Standard rpc.discover method
  registerMethod("rpc.discover", () => openRpcDoc, null);

  async function executeSingleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // JSON-RPC treats an absent and a null id alike: both make the call a
    // notification, which is answered with nothing. Collapsing the two here
    // means one value carries the id for every reply below.
    const id = req.id ?? null;
    const isNotification = id === null;

    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const entry = methodTable.get(req.method);
    if (!entry) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
    }

    try {
      let result: unknown;
      if (Array.isArray(req.params)) {
        result = await entry.fn(...req.params);
      } else if (req.params !== undefined && req.params !== null && typeof req.params === "object") {
        result = await entry.fn(req.params);
      } else if (req.params !== undefined) {
        result = await entry.fn(req.params);
      } else {
        result = await entry.fn();
      }

      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        result: result ?? null,
      };
    } catch (err: unknown) {
      if (isNotification) return null;
      const errObj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: typeof errObj?.code === "number" ? errObj.code : -32603,
          message: typeof errObj?.message === "string" ? errObj.message : "Internal error",
          data: errObj?.data,
        },
      };
    }
  }

  async function handleRequest(request: unknown): Promise<unknown> {
    if (Array.isArray(request)) {
      if (request.length === 0) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: empty batch" },
        };
      }
      const responses = await Promise.all(
        request.map((r) => executeSingleRequest(r))
      );
      const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
      return filtered.length > 0 ? filtered : null;
    }

    return await executeSingleRequest(request as JsonRpcRequest);
  }

  async function fetch(req: Request): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    let bodyText: string;
    try {
      bodyText = await req.text();
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const response = await handleRequest(parsed);
    if (response === null) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    return new Response(safeJsonStringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const websocket = {
    open(_ws: WebSocketLike) {},
    async message(ws: WebSocketLike, msg: string | Uint8Array | ArrayBuffer) {
      try {
        let text: string;
        if (typeof msg === "string") {
          text = msg;
        } else if (msg instanceof Uint8Array) {
          text = new TextDecoder().decode(msg);
        } else if (msg && typeof msg === "object" && "byteLength" in msg) {
          text = new TextDecoder().decode(new Uint8Array(msg));
        } else {
          text = String(msg);
        }
        const parsed = JSON.parse(text);
        const res = await handleRequest(parsed);
        if (res !== null && ws && typeof ws.send === "function") {
          ws.send(safeJsonStringify(res));
        }
      } catch {
        if (ws && typeof ws.send === "function") {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            })
          );
        }
      }
    },
    close(_ws: WebSocketLike) {},
  };

  const socket = {
    open(_socket: SocketLike) {},
    async data(soc: SocketLike, buf: Uint8Array | string) {
      try {
        const text = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const res = await handleRequest(parsed);
            if (res !== null && soc && typeof soc.write === "function") {
              soc.write(safeJsonStringify(res) + "\n");
            }
          } catch {
            if (soc && typeof soc.write === "function") {
              soc.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: "Parse error" },
                }) + "\n"
              );
            }
          }
        }
      } catch {
        // ignore malformed socket chunk
      }
    },
    close(_socket: SocketLike) {},
  };

  return {
    fetch,
    websocket,
    socket,
    handleRequest,
  };
}
