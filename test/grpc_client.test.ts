// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import protobuf from 'protobufjs';
import ts from 'typescript';
import { extractProtoIR } from '../src/extractors/proto.ts';
import { generate } from '../src/generators/generator.ts';
import { tsClientGenerator } from '../src/generators/tsClient.ts';
import type { ApiIR } from '../src/ir/api.ts';
import { isGrpcMethod } from '../src/ir/service.ts';
import { silentLogger } from '../src/logger.ts';

/**
 * The whole gRPC path, from `.proto` to a running client, checked against
 * protobufjs rather than against expectations written by the same hand that
 * wrote the extractor and the codec.
 */
const PROTO = `
syntax = "proto3";
package pets.v1;

// A pet on file.
message Pet {
  string id = 1;
  string name = 2;
  repeated string tags = 3;
  optional int32 age = 4;
  int64 microchip = 5;
  bytes photo = 6;
  Kind kind = 7;
  map<string, string> labels = 8;
}

enum Kind {
  KIND_UNSPECIFIED = 0;
  CAT = 1;
  DOG = 2;
}

message GetPetRequest {
  string id = 1;
}

message Note {
  string text = 1;
}

service Pets {
  // Fetch one pet.
  rpc GetPet (GetPetRequest) returns (Pet);
  rpc WatchPets (GetPetRequest) returns (stream Pet);
  rpc Upload (stream Note) returns (Note);
  rpc Chat (stream Note) returns (stream Note);
}
`;

let ir: ApiIR;
let files: Record<string, string>;
let root: protobuf.Root;

beforeAll(() => {
  ir = extractProtoIR(PROTO);
  files = generate(ir, tsClientGenerator, {}, silentLogger);
  root = protobuf.parse(PROTO).root;
});

describe('proto ingestion agrees with protobufjs', () => {
  test('the same messages are declared, under the same names', () => {
    const ours = [...ir.types.keys()].filter((name) => {
      const found = ir.types.get(name);
      return found?.kind === 'object';
    });

    const theirs: string[] = [];
    const walk = (parent: protobuf.NamespaceBase) => {
      for (const nested of parent.nestedArray) {
        if (nested instanceof protobuf.Type) {
          theirs.push(nested.fullName.replace(/^\./, ''));
          walk(nested);
        } else if (nested instanceof protobuf.Namespace) {
          walk(nested);
        }
      }
    };
    walk(root);

    expect(ours.sort()).toEqual(theirs.sort());
  });

  test('field numbers, repetition and optionality match', () => {
    for (const [name, type] of ir.types) {
      if (type.kind !== 'object') {
        continue;
      }
      const theirs = root.lookupType(name);

      for (const property of type.properties) {
        const field = theirs.fields[property.name];
        expect(field, `${name}.${property.name} exists`).toBeDefined();
        expect(property.fieldNumber).toBe(field!.id);
        // A map is repeated on the wire too, so only plain lists are compared.
        if (field!.repeated) {
          expect(property.type.kind).toBe('array');
        }
        if (field!.map) {
          expect(property.type.kind).toBe('record');
        }
      }

      expect(type.properties.length).toBe(Object.keys(theirs.fields).length);
    }
  });

  test('every rpc matches, streaming flags included', () => {
    const theirs = root.lookupService('pets.v1.Pets');
    const ours = ir.service.methods.filter(isGrpcMethod);

    expect(ours.map((method) => method.address.method).sort()).toEqual(
      theirs.methodsArray.map((method) => method.name).sort()
    );

    for (const method of ours) {
      const mirror = theirs.methods[method.address.method]!;
      mirror.resolve();
      expect(method.request.streaming).toBe(mirror.requestStream === true);
      expect(method.responses[0]!.streaming).toBe(mirror.responseStream === true);
      expect(method.request.message.name).toBe(
        mirror.resolvedRequestType!.fullName.replace(/^\./, '')
      );
      expect(method.responses[0]!.message.name).toBe(
        mirror.resolvedResponseType!.fullName.replace(/^\./, '')
      );
      expect(method.address.package).toBe('pets.v1');
      expect(method.address.service).toBe('Pets');
    }
  });

  test('widths protobufjs cannot express in TypeScript are carried as constraints', () => {
    const pet = ir.types.get('pets.v1.Pet');
    if (pet?.kind !== 'object') {
      throw new Error('expected Pet');
    }

    const format = (field: string) => {
      const property = pet.properties.find((candidate) => candidate.name === field);
      return property?.type.constraints?.find((c) => c.kind === 'format')?.value;
    };

    expect(format('age')).toBe('int32');
    expect(format('microchip')).toBe('int64');
    // A doc comment is the description, which is what reaches the model file.
    expect(pet.description).toBe('A pet on file.');
  });
});

describe('emitted gRPC client', () => {
  let directory: string;
  let apiPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wiz-grpc-'));
    apiPath = join(directory, 'api.ts');
    for (const [name, contents] of Object.entries(files)) {
      await Bun.write(join(directory, name), contents);
    }
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  test('the codec and the HTTP/2 transport are emitted alongside the api', () => {
    expect(Object.keys(files).sort()).toEqual(['api.ts', 'codec.ts', 'model.ts', 'transport.ts']);
    expect(files['api.ts']).toContain('from "./codec.ts";');
    expect(files['codec.ts']).toContain('export function encodePets_v1_Pet(');
    expect(files['codec.ts']).toContain('export function decodePets_v1_Pet(');
    // The transport is the only file that may mention node.
    expect(files['transport.ts']).toContain('import http2 from "node:http2";');
    expect(files['api.ts']).not.toContain('node:http2');
  });

  test('all four streaming directions are emitted with the shape callers expect', () => {
    const source = files['api.ts']!;

    // Proto names are fully qualified, so the model identifier is too, and each
    // direction's request and result carry a name of their own.
    expect(source).toContain('export type GetPetOptions = pets_v1_GetPetRequest;');
    expect(source).toContain('export type GetPetResult = pets_v1_Pet;');
    expect(source).toContain(
      'getPet(request: GetPetOptions, options?: GrpcCallOptions): Promise<GetPetResult>;'
    );
    // A server stream resolves to nothing: the result is the iterable itself.
    expect(source).toContain('export type WatchPetsResult = AsyncIterable<pets_v1_Pet>;');
    expect(source).toContain(
      'watchPets(request: WatchPetsOptions, options?: GrpcCallOptions): WatchPetsResult;'
    );
    // Streaming in takes a stream in, whichever transport ends up carrying it.
    expect(source).toContain('export type UploadOptions = AsyncIterable<pets_v1_Note>;');
    expect(source).toContain(
      'upload(requests: UploadOptions, options?: GrpcCallOptions): Promise<UploadResult>;'
    );
    expect(source).toContain('export type ChatOptions = AsyncIterable<pets_v1_Note>;');
    expect(source).toContain('export type ChatResult = AsyncIterable<pets_v1_Note>;');
    expect(source).toContain('chat(requests: ChatOptions, options?: GrpcCallOptions): ChatResult;');
  });

  test('the emitted api typechecks under strict TypeScript', () => {
    const program = ts.createProgram([apiPath, join(directory, 'transport.ts')], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
      types: ['bun'],
    });

    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));

    expect(diagnostics).toEqual([]);
  });

  interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
  }

  interface ResultLike {
    headers: Promise<{ status: number; headers: Record<string, string> }>;
    messages: AsyncIterable<Uint8Array>;
    trailers: Promise<Record<string, string>>;
  }

  type InterceptorLike = (call: Sent, next: (call: Sent) => ResultLike) => ResultLike;

  interface ConfigLike {
    baseUrl?: string;
    transport?: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }
    ) => Promise<Response>;
    interceptors?: { grpc?: InterceptorLike[] };
  }

  interface Operations {
    getPet(request: { id: string }): Promise<Record<string, unknown>>;
    watchPets(request: { id: string }): AsyncIterable<Record<string, unknown>>;
    upload(requests: AsyncIterable<{ text: string }>): Promise<unknown>;
  }

  interface ClientModule extends Operations {
    configure(next: ConfigLike): void;
    createClient(overrides?: ConfigLike): Operations;
    GrpcError: new (...args: never[]) => Error & { code: number; details: string };
  }

  /** gRPC-Web framing, written independently of the generator under test. */
  const frame = (payload: Uint8Array, trailer = false): Uint8Array => {
    const out = new Uint8Array(payload.length + 5);
    const view = new DataView(out.buffer);
    view.setUint8(0, trailer ? 0x80 : 0);
    view.setUint32(1, payload.length, false);
    out.set(payload, 5);
    return out;
  };

  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  const trailer = (status = 0, message = ''): Uint8Array =>
    frame(new TextEncoder().encode(`grpc-status: ${status}\r\ngrpc-message: ${message}\r\n`), true);

  const load = async (respond: (sent: Sent) => Response, sent: Sent[]): Promise<ClientModule> => {
    // A generated module is an external boundary; its shape is asserted once.
    const client = (await import(apiPath)) as unknown as ClientModule;
    client.configure({
      baseUrl: 'https://grpc.test',
      transport: async (url, init) => {
        const call = { url, method: init.method, headers: init.headers, body: init.body };
        sent.push(call);
        return respond(call);
      },
      interceptors: {
        grpc: [
          (call, next) =>
            next({ ...call, headers: { ...call.headers, authorization: 'Bearer token' } }),
        ],
      },
    });
    return client;
  };

  test('a unary call frames the request protobufjs can read, and reads its reply', async () => {
    const petType = root.lookupType('pets.v1.Pet');
    const requestType = root.lookupType('pets.v1.GetPetRequest');
    const pet = {
      id: 'p1',
      name: 'Rex',
      tags: ['good', 'dog'],
      age: 4,
      microchip: '900000000000001',
      photo: new Uint8Array([1, 2, 3]),
      kind: 2,
      labels: { room: 'kitchen' },
    };

    const sent: Sent[] = [];
    const client = await load(
      () =>
        new Response(concat(frame(petType.encode(pet).finish()), trailer()), {
          status: 200,
          headers: { 'content-type': 'application/grpc-web+proto' },
        }),
      sent
    );

    const received = await client.getPet({ id: 'p1' });

    // Our reader against protobufjs's writer.
    expect(received.id).toBe('p1');
    expect(received.tags).toEqual(['good', 'dog']);
    expect(received.age).toBe(4);
    expect(received.microchip).toBe(900000000000001n);
    expect(received.photo).toEqual(new Uint8Array([1, 2, 3]));
    expect(received.labels).toEqual({ room: 'kitchen' });

    // Our writer against protobufjs's reader, taken off the framed request.
    const call = sent[0]!;
    expect(call.url).toBe('https://grpc.test/pets.v1.Pets/GetPet');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/grpc-web+proto');
    expect(call.headers['x-grpc-web']).toBe('1');
    // The chain applies to gRPC exactly as it does to HTTP.
    expect(call.headers.authorization).toBe('Bearer token');

    const body = call.body as Uint8Array;
    expect(body[0]).toBe(0);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(1, false)).toBe(body.length - 5);
    expect(requestType.decode(body.subarray(5)).toJSON()).toEqual({ id: 'p1' });
  });

  /**
   * A retry is the caller's to write, and this is what makes it possible: the
   * unary request is a re-iterable array, so calling `next` a second time sends
   * the same message again instead of an empty stream. Wrapping `messages` is
   * how an interceptor sees a failure at all - it arrives as a throw from the
   * stream, not as a rejected result.
   */
  test('a gRPC interceptor can retry a failed unary call', async () => {
    const petType = root.lookupType('pets.v1.Pet');
    const requestType = root.lookupType('pets.v1.GetPetRequest');
    const webHeaders = { 'content-type': 'application/grpc-web+proto' };

    // The module-level client is only how the module is imported here; the
    // retrying client below answers its own calls.
    const client = await load(
      () => new Response(trailer(), { status: 200, headers: webHeaders }),
      []
    );

    const sent: Sent[] = [];
    const retrying = client.createClient({
      baseUrl: 'https://grpc.test',
      transport: async (url, init) => {
        sent.push({ url, method: init.method, headers: init.headers, body: init.body });
        return sent.length === 1
          ? new Response(trailer(14, 'try again'), { status: 200, headers: webHeaders })
          : new Response(
              concat(frame(petType.encode({ id: 'p1', name: 'Rex' }).finish()), trailer()),
              { status: 200, headers: webHeaders }
            );
      },
      interceptors: {
        grpc: [
          (call, next) => {
            const first = next(call);
            return {
              headers: first.headers,
              trailers: first.trailers,
              messages: (async function* () {
                try {
                  yield* first.messages;
                } catch {
                  // Nothing was yielded, so the second attempt is the whole call.
                  yield* next(call).messages;
                }
              })(),
            };
          },
        ],
      },
    });

    const received = await retrying.getPet({ id: 'p1' });

    expect(received.name).toBe('Rex');
    expect(sent).toHaveLength(2);
    // The same request, sent twice: the array was iterated again.
    for (const call of sent) {
      expect(requestType.decode((call.body as Uint8Array).subarray(5)).toJSON()).toEqual({
        id: 'p1',
      });
    }
  });

  /** A frame flagged compressed, whatever the algorithm turns out to be. */
  const compressedFrame = (payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(payload.length + 5);
    const view = new DataView(out.buffer);
    // Bit 0 is the compressed-payload flag.
    view.setUint8(0, 0x01);
    view.setUint32(1, payload.length, false);
    out.set(payload, 5);
    return out;
  };

  const gzipped = async (payload: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  test('a compressed reply is decompressed with the encoding the server named', async () => {
    const petType = root.lookupType('pets.v1.Pet');
    const body = concat(
      compressedFrame(await gzipped(petType.encode({ id: 'z', name: 'Zip' }).finish())),
      trailer()
    );

    const sent: Sent[] = [];
    const client = await load(
      () =>
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/grpc-web+proto',
            'grpc-encoding': 'gzip',
          },
        }),
      sent
    );

    expect(await client.getPet({ id: 'z' })).toMatchObject({ id: 'z', name: 'Zip' });
    // Every call advertises what it can read, so a server may compress at will.
    expect(sent[0]!.headers['grpc-accept-encoding']).toBe('gzip, deflate, identity');
  });

  test('a frame flagged compressed with no encoding named is refused', async () => {
    const sent: Sent[] = [];
    const client = await load(
      () =>
        new Response(concat(compressedFrame(new Uint8Array([1, 2, 3])), trailer()), {
          status: 200,
          headers: { 'content-type': 'application/grpc-web+proto' },
        }),
      sent
    );

    const failure = await client.getPet({ id: 'x' }).catch((error: unknown) => error);
    if (!(failure instanceof client.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    expect(failure.code).toBe(12);
    expect(failure.details).toContain("'identity'");
  });

  test('a server stream yields each frame as it arrives', async () => {
    const petType = root.lookupType('pets.v1.Pet');
    const bodies = [
      frame(petType.encode({ id: 'a', name: 'A' }).finish()),
      frame(petType.encode({ id: 'b', name: 'B' }).finish()),
      trailer(),
    ];

    const sent: Sent[] = [];
    const client = await load(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Split across chunks, and mid-frame, so the reader has to buffer.
              const all = concat(...bodies);
              controller.enqueue(all.subarray(0, 3));
              controller.enqueue(all.subarray(3, all.length - 4));
              controller.enqueue(all.subarray(all.length - 4));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } }
        ),
      sent
    );

    const ids: unknown[] = [];
    for await (const pet of client.watchPets({ id: 'all' })) {
      ids.push(pet.id);
    }

    expect(ids).toEqual(['a', 'b']);
  });

  test('a non-zero status becomes a GrpcError carrying code and message', async () => {
    const sent: Sent[] = [];
    const client = await load(
      () =>
        new Response(trailer(5, 'no such pet'), {
          status: 200,
          headers: { 'content-type': 'application/grpc-web+proto' },
        }),
      sent
    );

    const failure = await client.getPet({ id: 'missing' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(client.GrpcError);
    if (!(failure instanceof client.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    expect(failure.code).toBe(5);
    expect(failure.details).toBe('no such pet');
  });

  test('a trailers-only failure is read from the headers', async () => {
    const sent: Sent[] = [];
    const client = await load(
      () =>
        new Response(null, {
          status: 200,
          headers: { 'grpc-status': '7', 'grpc-message': 'denied' },
        }),
      sent
    );

    const failure = await client.getPet({ id: 'x' }).catch((error: unknown) => error);
    if (!(failure instanceof client.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    expect(failure.code).toBe(7);
    expect(failure.details).toBe('denied');
  });

  /**
   * The method exists with its real signature; what it cannot do is run over a
   * transport that sends one complete body. That refusal belongs to the
   * transport, not to the generated method, because a client can be
   * reconfigured onto the HTTP/2 one and the same method then works.
   */
  test('streaming a request refuses on the fetch transport, naming the fix', async () => {
    const sent: Sent[] = [];
    const client = await load(() => new Response(null), sent);

    async function* notes(): AsyncGenerator<{ text: string }> {
      yield { text: 'one' };
      yield { text: 'two' };
    }

    const failure = await client.upload(notes()).catch((error: unknown) => error);
    if (!(failure instanceof client.GrpcError)) {
      throw new Error('expected GrpcError');
    }
    // 12 is UNIMPLEMENTED, which is what this transport is for this call.
    expect(failure.code).toBe(12);
    expect(failure.details).toContain('createHttp2Transport()');
  });
});
