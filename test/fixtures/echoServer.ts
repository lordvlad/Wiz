import { join } from 'node:path';
// @wiz-ignore
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';

/**
 * A real gRPC server, so the emitted client is checked against an
 * implementation nobody here wrote.
 *
 * `@grpc/grpc-js` is the reference implementation: it does its own HTTP/2, its
 * own framing and its own protobuf. If a call succeeds against this, the client
 * speaks gRPC rather than something that merely looks like it.
 */
export const ECHO_PROTO = join(import.meta.dir, 'echo.proto');

interface Ping {
  text: string;
  count: number;
}

interface Pong {
  text: string;
}

type Callback = (error: grpc.ServiceError | null, value?: Pong, trailing?: grpc.Metadata) => void;

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startEchoServer(): Promise<RunningServer> {
  const definition = loader.loadSync(ECHO_PROTO, {
    keepCase: true,
    longs: String,
    defaults: true,
  });
  const loaded = grpc.loadPackageDefinition(definition);
  const echo = loaded.echo as {
    v1: { Echo: grpc.ServiceClientConstructor };
  };

  // 2 is gzip in grpc-js's algorithm table: replies come back compressed when
  // the client says it accepts them that way, which is what exercises our
  // decompression against a real implementation.
  const server = new grpc.Server({ 'grpc.default_compression_algorithm': 2 });
  server.addService(echo.v1.Echo.service, {
    // Unary, plus the one path that answers with a status instead of a message.
    // Both append trailing metadata, which is where a real server explains
    // itself beyond the status code.
    Unary: (call: grpc.ServerUnaryCall<Ping, Pong>, callback: Callback) => {
      const trailing = new grpc.Metadata();
      trailing.set('x-request-id', 'req-42');

      if (call.request.text === 'boom') {
        trailing.set('x-retry-after', '5');
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          details: 'no booms here',
          metadata: trailing,
          name: 'Error',
          message: 'no booms here',
        });
        return;
      }
      callback(null, { text: `pong:${call.request.text}` }, trailing);
    },

    Down: (call: grpc.ServerWritableStream<Ping, Pong>) => {
      const count = call.request.count > 0 ? call.request.count : 2;
      for (let index = 0; index < count; index += 1) {
        call.write({ text: `${call.request.text}#${index}` });
      }
      call.end();
    },

    Up: (call: grpc.ServerReadableStream<Ping, Pong>, callback: Callback) => {
      const seen: string[] = [];
      call.on('data', (ping: Ping) => seen.push(ping.text));
      call.on('end', () => callback(null, { text: seen.join(',') }));
    },

    Both: (call: grpc.ServerDuplexStream<Ping, Pong>) => {
      call.on('data', (ping: Ping) => call.write({ text: `re:${ping.text}` }));
      call.on('end', () => call.end());
    },

    // Never answers, so a deadline has something to expire against.
    Never: () => {},
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound)
    );
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.forceShutdown();
        resolve();
      }),
  };
}
