export interface OpenRpcHandlerOptions {
  services?: any[] | Record<string, any>;
  methods?: Record<string, (...args: any[]) => any>;
  info?: { title?: string; version?: string; description?: string };
  doc?: Record<string, unknown>;
}

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface OpenRpcHandler {
  fetch(req: Request): Promise<Response>;
  websocket: {
    open(ws: any): void;
    message(ws: any, msg: string | Uint8Array): Promise<void>;
    close(ws: any): void;
  };
  socket: {
    open(socket: any): void;
    data(socket: any, buf: Uint8Array | string): Promise<void>;
    close(socket: any): void;
  };
  handleRequest(request: unknown): Promise<unknown>;
}

export function openRPCHandler(options: OpenRpcHandlerOptions): OpenRpcHandler {
  const methodTable = new Map<string, { fn: (...args: any[]) => any; target: any }>();

  function registerMethod(name: string, fn: (...args: any[]) => any, target: any) {
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
    const servicesList: Array<{ name?: string; instance: any }> = [];

    if (Array.isArray(options.services)) {
      for (const item of options.services) {
        if (item && typeof item === "object") {
          const name = item.constructor && item.constructor.name !== "Object"
            ? item.constructor.name
            : undefined;
          servicesList.push({ name, instance: item });
        }
      }
    } else if (typeof options.services === "object") {
      for (const [key, item] of Object.entries(options.services)) {
        if (item && typeof item === "object") {
          servicesList.push({ name: key, instance: item });
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
        const fn = instance[methodName].bind(instance);
        if (serviceName) {
          registerMethod(`${serviceName}.${methodName}`, fn, instance);
        }
        registerMethod(methodName, fn, instance);
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
    const isNotification = req.id === undefined || req.id === null;

    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const entry = methodTable.get(req.method);
    if (!entry) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
    }

    try {
      let result: any;
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
        id: req.id,
        result: result ?? null,
      };
    } catch (err: any) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: typeof err?.code === "number" ? err.code : -32603,
          message: err?.message ?? "Internal error",
          data: err?.data,
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

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const websocket = {
    open(_ws: any) {},
    async message(ws: any, msg: string | Uint8Array) {
      try {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
        const parsed = JSON.parse(text);
        const res = await handleRequest(parsed);
        if (res !== null && ws && typeof ws.send === "function") {
          ws.send(JSON.stringify(res));
        }
      } catch (err) {
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
    close(_ws: any) {},
  };

  const socket = {
    open(_socket: any) {},
    async data(soc: any, buf: Uint8Array | string) {
      try {
        const text = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const res = await handleRequest(parsed);
            if (res !== null && soc && typeof soc.write === "function") {
              soc.write(JSON.stringify(res) + "\n");
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
    close(_socket: any) {},
  };

  return {
    fetch,
    websocket,
    socket,
    handleRequest,
  };
}
