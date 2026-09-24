// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractProtoIRFromFile } from '../src/extractors/proto.ts';
import { generate } from '../src/generators/generator.ts';
import { tsClientGenerator } from '../src/generators/tsClient.ts';
import { silentLogger } from '../src/logger.ts';
import { ECHO_PROTO, startEchoServer, type RunningServer } from './fixtures/echoServer.ts';

/**
 * The generated client against `@grpc/grpc-js`, over real HTTP/2.
 *
 * Everything else about gRPC can be tested with a stub; this cannot. Framing,
 * trailers, stream lifetimes and status codes are only proven by talking to an
 * implementation that was written by someone else.
 */
interface Ping {
  text: string;
  count: number;
}

interface Pong {
  text: string;
}

interface Transport {
  duplex: boolean;
  close(): void;
}

interface EchoClient {
  unary(request: Ping, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Pong>;
  down(request: Ping): AsyncIterable<Pong>;
  up(requests: AsyncIterable<Ping>): Promise<Pong>;
  both(requests: AsyncIterable<Ping>): AsyncIterable<Pong>;
  never(request: Ping, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Pong>;
}

interface ClientModule {
  configure(next: { baseUrl?: string; transport?: Transport; timeoutMs?: number }): void;
  createClient(overrides: {
    baseUrl?: string;
    transport?: Transport;
    compression?: 'identity' | 'gzip' | 'deflate';
    interceptors?: {
      grpc?: Array<
        (
          call: { method: string; url: string; headers: Record<string, string> },
          next: (call: { method: string; url: string; headers: Record<string, string> }) => {
            trailers: Promise<Record<string, string>>;
          }
        ) => { trailers: Promise<Record<string, string>> }
      >;
    };
  }): EchoClient;
  GrpcError: new (...args: never[]) => Error & {
    code: number;
    details: string;
    metadata: Record<string, string>;
  };
}

interface TransportModule {
  /** No URL: the origin comes off each call, from the client's `baseUrl`. */
  createHttp2Transport(): Transport;
}

let server: RunningServer;
let directory: string;
let api: ClientModule;
let transport: Transport;
let client: EchoClient;

const ping = (text: string, count = 0): Ping => ({ text, count });

beforeAll(async () => {
  server = await startEchoServer();
  directory = await mkdtemp(join(tmpdir(), 'wiz-interop-'));

  const ir = await extractProtoIRFromFile(ECHO_PROTO);
  const files = generate(ir, tsClientGenerator, {}, silentLogger);
  for (const [name, contents] of Object.entries(files)) {
    await Bun.write(join(directory, name), contents);
  }

  // Generated modules are an external boundary; their shape is asserted once.
  api = (await import(join(directory, 'api.ts'))) as unknown as ClientModule;
  const transportModule = (await import(
    join(directory, 'transport.ts')
  )) as unknown as TransportModule;

  transport = transportModule.createHttp2Transport();
  client = api.createClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    transport,
  });
});

afterAll(async () => {
  transport?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

describe('against @grpc/grpc-js over HTTP/2', () => {
  test('the transport reports that it can stream requests', () => {
    expect(transport.duplex).toBe(true);
  });

  test('unary', async () => {
    expect(await client.unary(ping('hello'))).toEqual({ text: 'pong:hello' });
  });

  test('server streaming', async () => {
    const seen: string[] = [];
    for await (const pong of client.down(ping('tick', 3))) {
      seen.push(pong.text);
    }

    expect(seen).toEqual(['tick#0', 'tick#1', 'tick#2']);
  });

  test('client streaming', async () => {
    async function* pings(): AsyncGenerator<Ping> {
      yield ping('a');
      yield ping('b');
      yield ping('c');
    }

    expect(await client.up(pings())).toEqual({ text: 'a,b,c' });
  });

  test('bidirectional streaming', async () => {
    async function* pings(): AsyncGenerator<Ping> {
      yield ping('one');
      yield ping('two');
    }

    const seen: string[] = [];
    for await (const pong of client.both(pings())) {
      seen.push(pong.text);
    }

    expect(seen).toEqual(['re:one', 're:two']);
  });

  test('a server-side status becomes a GrpcError with its code and details', async () => {
    const failure = await client.unary(ping('boom')).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(api.GrpcError);
    if (!(failure instanceof api.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    // 3 is INVALID_ARGUMENT, which is what the server answered with.
    expect(failure.code).toBe(3);
    expect(failure.details).toBe('no booms here');
  });

  test('a deadline expires locally as DEADLINE_EXCEEDED', async () => {
    const failure = await client
      .never(ping('wait'), { timeoutMs: 150 })
      .catch((error: unknown) => error);

    if (!(failure instanceof api.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    expect(failure.code).toBe(4);
    expect(failure.details).toBe('deadline exceeded');
  });

  test('an abort signal cancels the call', async () => {
    const controller = new AbortController();
    const pending = client
      .never(ping('wait'), { signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();

    const failure = await pending;
    if (!(failure instanceof api.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    expect(failure.code).toBe(1);
    expect(failure.details).toBe('cancelled');
  });

  test('many calls share one connection', async () => {
    const answers = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((text) => client.unary(ping(text)))
    );

    expect(answers.map((pong) => pong.text)).toEqual([
      'pong:a',
      'pong:b',
      'pong:c',
      'pong:d',
      'pong:e',
    ]);
  });

  test('the module-level functions work through the same transport', async () => {
    api.configure({
      baseUrl: `http://127.0.0.1:${server.port}`,
      transport,
    });

    const { unary } = (await import(join(directory, 'api.ts'))) as unknown as {
      unary(request: Ping): Promise<Pong>;
    };

    expect(await unary(ping('module'))).toEqual({ text: 'pong:module' });
  });

  /**
   * The transport takes no URL, so the origin comes off each call. One
   * transport therefore serves several base URLs, one session each - which is
   * also what keeps `baseUrl` the single place a URL is written.
   */
  test('one transport serves two origins', async () => {
    const other = await startEchoServer();
    try {
      const elsewhere = api.createClient({
        baseUrl: `http://127.0.0.1:${other.port}`,
        transport,
      });

      expect(await elsewhere.unary(ping('second'))).toEqual({ text: 'pong:second' });
      expect(await client.unary(ping('first'))).toEqual({ text: 'pong:first' });
    } finally {
      await other.close();
    }
  });

  /**
   * Trailing metadata is where a server says what a status code cannot. An
   * interceptor reads it off the result rather than awaiting the call, which is
   * the only way it can be read at all: trailers arrive after the messages a
   * caller has not consumed yet.
   */
  test('an interceptor reads the trailing metadata off the result', async () => {
    const seen: Array<Record<string, string>> = [];
    const observed = api.createClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      transport,
      interceptors: {
        grpc: [
          (call, next) => {
            const result = next(call);
            void result.trailers.then((trailers) => seen.push(trailers)).catch(() => {});
            return result;
          },
        ],
      },
    });

    expect(await observed.unary(ping('watched'))).toEqual({ text: 'pong:watched' });
    // The call is over, but the promise callback is a microtask behind it.
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0]!['x-request-id']).toBe('req-42');
  });

  test('a failure carries the trailing metadata the server appended', async () => {
    const failure = await client.unary(ping('boom')).catch((error: unknown) => error);

    if (!(failure instanceof api.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    expect(failure.code).toBe(3);
    expect(failure.metadata['x-retry-after']).toBe('5');
    expect(failure.metadata['x-request-id']).toBe('req-42');
  });

  /**
   * Compression is negotiated per message, in both directions, and neither side
   * here is ours: grpc-js compresses its replies because the client said it
   * accepts gzip, and it decompresses our requests because we said we sent gzip.
   */
  test('gzip travels both ways', async () => {
    const compressing = api.createClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      transport,
      compression: 'gzip',
    });

    // Long enough that compression is not a no-op on the wire.
    const text = 'compress me '.repeat(40);
    expect(await compressing.unary(ping(text))).toEqual({ text: `pong:${text}` });

    const seen: string[] = [];
    for await (const pong of compressing.down(ping(text, 2))) {
      seen.push(pong.text);
    }
    expect(seen).toEqual([`${text}#0`, `${text}#1`]);
  });

  test('deflate is accepted too', async () => {
    const deflating = api.createClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      transport,
      compression: 'deflate',
    });

    expect(await deflating.unary(ping('deflated'))).toEqual({
      text: 'pong:deflated',
    });
  });
});
