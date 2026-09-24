export interface OpenRpcCall {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: unknown;
  meta?: Record<string, string>;
}

export interface OpenRpcResult {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface OpenRpcTransport {
  call(call: OpenRpcCall): Promise<OpenRpcResult>;
  close?(): void;
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebSocketLike {
  readyState?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close?(): void;
  addEventListener?(
    type: string,
    listener: (ev: unknown) => void,
    options?: { once?: boolean }
  ): void;
  onmessage?: ((ev: unknown) => void) | null;
  onopen?: ((ev: unknown) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
  onclose?: ((ev: unknown) => void) | null;
}

export interface SocketLike {
  write?(data: string | Uint8Array): void;
  send?(data: string | Uint8Array): void;
  end?(): void;
  close?(): void;
  on?(event: string, listener: (data: unknown) => void): void;
}

export interface HttpTransportOptions {
  url?: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}
export function httpTransport(options: HttpTransportOptions = {}): OpenRpcTransport {
  const url = options.url ?? 'http://localhost/rpc';
  const fetchFn = options.fetch ?? globalThis.fetch;

  return {
    async call(callReq: OpenRpcCall): Promise<OpenRpcResult> {
      const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
        ...callReq.meta,
      };

      const payload = {
        jsonrpc: '2.0',
        id: callReq.id,
        method: callReq.method,
        params: callReq.params,
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`[httpTransport] HTTP error ${res.status}: ${res.statusText}`);
      }

      const bodyText = await res.text();
      try {
        return JSON.parse(bodyText) as OpenRpcResult;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[httpTransport] Failed to parse JSON response: ${msg}`);
      }
    },
  };
}

export interface WebSocketTransportOptions {
  url: string;
  ws?: WebSocketLike;
}

export function webSocketTransport(options: WebSocketTransportOptions): OpenRpcTransport {
  let socket: WebSocketLike | undefined = options.ws;
  const pending = new Map<
    string | number,
    { resolve: (res: OpenRpcResult) => void; reject: (err: unknown) => void }
  >();

  function handleMessage(event: unknown) {
    try {
      const evObj = event as { data?: unknown };
      const text =
        typeof evObj.data === 'string'
          ? evObj.data
          : evObj.data instanceof Uint8Array
            ? new TextDecoder().decode(evObj.data)
            : typeof evObj.data === 'object' && evObj.data !== null && 'byteLength' in evObj.data
              ? new TextDecoder().decode(new Uint8Array(evObj.data as ArrayBuffer))
              : String(evObj.data);
      const data = JSON.parse(text) as OpenRpcResult;
      if (data && data.id !== undefined && pending.has(data.id)) {
        const handler = pending.get(data.id)!;
        pending.delete(data.id);
        handler.resolve(data);
      }
    } catch {
      // ignore
    }
  }

  function bindSocket(s: WebSocketLike) {
    if (typeof s.addEventListener === 'function') {
      s.addEventListener('message', handleMessage);
    } else {
      s.onmessage = handleMessage;
    }
  }

  if (socket) {
    bindSocket(socket);
  }

  function getSocket(): Promise<WebSocketLike> {
    if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
      if (socket.readyState === 1) {
        return Promise.resolve(socket);
      }
      const { promise, resolve, reject } = Promise.withResolvers<WebSocketLike>();
      const onOpen = () => resolve(socket!);
      const onError = (e: unknown) => reject(e);
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
      } else {
        socket.onopen = onOpen;
        socket.onerror = onError;
      }
      return promise;
    }

    const WS = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike })
      .WebSocket;
    if (!WS) {
      throw new Error('WebSocket implementation not available');
    }

    socket = new WS(options.url);
    bindSocket(socket);

    const { promise, resolve, reject } = Promise.withResolvers<WebSocketLike>();
    socket.onopen = () => resolve(socket!);
    socket.onerror = (e: unknown) => reject(e);
    return promise;
  }

  return {
    async call(callReq: OpenRpcCall): Promise<OpenRpcResult> {
      const ws = await getSocket();
      return new Promise((resolve, reject) => {
        pending.set(callReq.id, { resolve, reject });
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: callReq.id,
          method: callReq.method,
          params: callReq.params,
        });
        ws.send(payload);
      });
    },
    close() {
      if (socket && typeof socket.close === 'function') {
        socket.close();
      }
      pending.clear();
    },
  };
}

export interface TcpTransportOptions {
  host?: string;
  port?: number;
  path?: string;
  socket?: SocketLike;
}

export function tcpTransport(options: TcpTransportOptions): OpenRpcTransport {
  let conn: SocketLike | undefined = options.socket;
  const pending = new Map<
    string | number,
    { resolve: (res: OpenRpcResult) => void; reject: (err: unknown) => void }
  >();
  let buffer = '';

  function setupSocket(s: SocketLike) {
    if (typeof s.on === 'function') {
      s.on('data', (data: unknown) => {
        const text =
          typeof data === 'string'
            ? data
            : data instanceof Uint8Array
              ? new TextDecoder().decode(data)
              : String(data);
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const parsed = JSON.parse(line) as OpenRpcResult;
            if (parsed && parsed.id !== undefined && pending.has(parsed.id)) {
              const h = pending.get(parsed.id)!;
              pending.delete(parsed.id);
              h.resolve(parsed);
            }
          } catch {}
        }
      });
    }
  }

  if (conn) {
    setupSocket(conn);
  }

  async function getConn(): Promise<SocketLike> {
    if (conn) {
      return conn;
    }

    const bunObj = (
      globalThis as unknown as { Bun?: { connect?: (opts: unknown) => Promise<SocketLike> } }
    ).Bun;
    if (typeof bunObj?.connect === 'function') {
      conn = await bunObj.connect({
        hostname: options.host ?? '127.0.0.1',
        port: options.port ?? 8080,
        socket: {
          data(_socket: unknown, data: Uint8Array) {
            const text = new TextDecoder().decode(data);
            buffer += text;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              try {
                const parsed = JSON.parse(line) as OpenRpcResult;
                if (parsed && parsed.id !== undefined && pending.has(parsed.id)) {
                  const h = pending.get(parsed.id)!;
                  pending.delete(parsed.id);
                  h.resolve(parsed);
                }
              } catch {}
            }
          },
        },
      });
      return conn;
    }

    throw new Error('[tcpTransport] Bun.connect or socket option required');
  }

  return {
    async call(callReq: OpenRpcCall): Promise<OpenRpcResult> {
      const c = await getConn();
      return new Promise((resolve, reject) => {
        pending.set(callReq.id, { resolve, reject });
        const payload = `${JSON.stringify({
          jsonrpc: '2.0',
          id: callReq.id,
          method: callReq.method,
          params: callReq.params,
        })}\n`;

        if (typeof c.write === 'function') {
          c.write(payload);
        } else if (typeof c.send === 'function') {
          c.send(payload);
        }
      });
    },
    close() {
      if (conn && typeof conn.end === 'function') {
        conn.end();
      } else if (conn && typeof conn.close === 'function') {
        conn.close();
      }
      pending.clear();
    },
  };
}

export type Interceptor = (
  call: OpenRpcCall,
  next: (req: OpenRpcCall) => Promise<OpenRpcResult>
) => Promise<OpenRpcResult>;

export interface OpenRpcClientOptions {
  transport?: OpenRpcTransport;
  url?: string;
  interceptors?: Interceptor[];
  timeoutMs?: number;
}

export function openRpcClient<T = any>(options: OpenRpcClientOptions = {}): T {
  const transport = options.transport ?? httpTransport({ url: options.url });
  const interceptors = options.interceptors ?? [];
  let reqId = 0;

  async function executeCall(methodName: string, params: unknown): Promise<unknown> {
    const callReq: OpenRpcCall = {
      jsonrpc: '2.0',
      id: ++reqId,
      method: methodName,
      params,
    };

    let dispatch = (req: OpenRpcCall): Promise<OpenRpcResult> => transport.call(req);

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const next = dispatch;
      const interceptor = interceptors[i]!;
      dispatch = (req) => interceptor(req, next);
    }

    let promise = dispatch(callReq);

    if (options.timeoutMs && options.timeoutMs > 0) {
      promise = Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`[openRpcClient] Request timed out after ${options.timeoutMs}ms`)),
            options.timeoutMs
          )
        ),
      ]);
    }

    const res = await promise;
    if (res.error) {
      const err = new Error(res.error.message);
      (err as any).code = res.error.code;
      (err as any).data = res.error.data;
      throw err;
    }

    return res.result;
  }

  const serviceProxyCache = new Map<string, any>();

  const clientProxy = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop !== 'string') {
          return undefined;
        }
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return undefined;
        }

        if (serviceProxyCache.has(prop)) {
          return serviceProxyCache.get(prop);
        }

        const methodOrServiceProxy = new Proxy(
          (...args: unknown[]) => {
            const params = args.length === 1 ? args[0] : args;
            return executeCall(prop, params);
          },
          {
            get(_subTarget, subProp: string | symbol) {
              if (typeof subProp !== 'string') {
                return undefined;
              }
              if (subProp === 'then' || subProp === 'catch' || subProp === 'finally') {
                return undefined;
              }
              return (...args: unknown[]) => {
                const params = args.length === 1 ? args[0] : args;
                return executeCall(`${prop}.${subProp}`, params);
              };
            },
          }
        );

        serviceProxyCache.set(prop, methodOrServiceProxy);
        return methodOrServiceProxy;
      },
    }
  );

  return clientProxy as T;
}
