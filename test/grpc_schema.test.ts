// @wiz-ignore
import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";
import { generateGrpcSchemaCode } from "../src/generators/protobuf.ts";
import { grpcSchema } from "../src/index.ts";
import type { ServiceIR } from "../src/ir/service.ts";
import { silentLogger } from "../src/logger.ts";
import { transformSource } from "../src/plugin.ts";
import { evalModule } from "./helpers.ts";

/** The `.proto` text one `grpcSchema<…>()` callsite compiles to. */
function protoFor(source: string, indent = "  "): string {
  const res = transformSource({
    path: "test.ts",
    contents: source,
    logger: silentLogger,
  });
  expect(res.code).toContain("grpcSchema as __wiz_grpcSchema_");

  const module = Array.from(res.modules.values()).find((m) =>
    m.files["index.js"]?.includes("export function grpcSchema")
  );
  expect(module).toBeDefined();

  return evalModule<{ grpcSchema: (o?: { indent?: string }) => string }>(
    module!.files["index.js"]!
  ).grpcSchema({ indent });
}

const GREETER = `
  import { grpcSchema } from "./src/index.ts";

  interface HelloRequest {
    /** @fieldNumber 1 */
    name: string;
  }

  interface HelloReply {
    /** @fieldNumber 1 */
    message: string;
  }

  /**
   * @package helloworld
   * @service Greeter
   */
  interface GreeterService {
    /** Greets one caller. */
    sayHello(request: HelloRequest): Promise<HelloReply>;
    sayHelloStream(request: HelloRequest): AsyncIterable<HelloReply>;
    recordHellos(requests: AsyncIterable<HelloRequest>): Promise<HelloReply>;
    chat(requests: AsyncIterable<HelloRequest>): AsyncGenerator<HelloReply>;
  }

  export const proto = grpcSchema<[GreeterService]>();
`;

describe("grpcSchema stub", () => {
  test("throws without the plugin, like every other macro", () => {
    expect(() => grpcSchema()).toThrow("without active Bun plugin");
  });
});

describe("grpcSchema harvesting", () => {
  test("a service interface becomes messages and a service block", () => {
    const proto = protoFor(GREETER);

    expect(proto).toContain('syntax = "proto3";');
    expect(proto).toContain("package helloworld;");
    expect(proto).toContain("message HelloRequest {");
    expect(proto).toContain("string name = 1;");
    expect(proto).toContain("message HelloReply {");
    expect(proto).toContain("service Greeter {");
    expect(proto).toContain("// Greets one caller.");
    expect(proto).toContain("rpc sayHello (HelloRequest) returns (HelloReply);");
  });

  test("streaming is read off the signature, on each side", () => {
    const proto = protoFor(GREETER);

    // Server streaming: the return type is the async iterable.
    expect(proto).toContain(
      "rpc sayHelloStream (HelloRequest) returns (stream HelloReply);"
    );
    // Client streaming: the first parameter is.
    expect(proto).toContain(
      "rpc recordHellos (stream HelloRequest) returns (HelloReply);"
    );
    // Bidirectional: both.
    expect(proto).toContain(
      "rpc chat (stream HelloRequest) returns (stream HelloReply);"
    );
  });

  test("protobuf.js parses the emitted file", () => {
    const parsed = protobuf.parse(protoFor(GREETER), { keepCase: true });
    expect(parsed.package).toBe("helloworld");

    const service = parsed.root.lookupService("helloworld.Greeter");
    const chat = service.methods["chat"]!;
    expect(chat.requestStream).toBe(true);
    expect(chat.responseStream).toBe(true);
    expect(chat.requestType).toBe("HelloRequest");

    const unary = service.methods["sayHello"]!;
    expect(unary.requestStream).toBeFalsy();
    expect(unary.responseStream).toBeFalsy();
  });

  test("@name renames the rpc and @service the block", () => {
    const proto = protoFor(`
      import { grpcSchema } from "./src/index.ts";

      interface Ping {
        /** @fieldNumber 1 */
        nonce: number;
      }

      interface HealthApi {
        /**
         * @name Check
         * @service Health
         */
        checkHealth(request: Ping): Promise<Ping>;
      }

      export const proto = grpcSchema<[HealthApi]>();
    `);

    expect(proto).toContain("service Health {");
    expect(proto).toContain("rpc Check (Ping) returns (Ping);");
    expect(proto).not.toContain("package");
  });

  test("a function signature type is one rpc", () => {
    const proto = protoFor(`
      import { grpcSchema } from "./src/index.ts";

      interface Empty {}

      /**
       * @package ops
       * @service Admin
       * @name Restart
       */
      declare function restart(request: Empty): Promise<Empty>;

      export const proto = grpcSchema<[typeof restart]>();
    `);

    expect(proto).toContain("package ops;");
    expect(proto).toContain("service Admin {");
    expect(proto).toContain("rpc Restart (Empty) returns (Empty);");
  });

  test("an anonymous or missing payload gets a message of its own", () => {
    const proto = protoFor(`
      import { grpcSchema } from "./src/index.ts";

      interface Pinger {
        ping(): Promise<{
          /** @fieldNumber 1 */
          up: boolean;
        }>;
      }

      export const proto = grpcSchema<[Pinger]>();
    `);

    expect(proto).toContain("message PingRequest {");
    expect(proto).toContain("message PingResponse {");
    expect(proto).toContain("bool up = 1;");
    expect(proto).toContain("rpc ping (PingRequest) returns (PingResponse);");
    // An empty request stays a message rather than importing Empty.
    expect(proto).not.toContain("google/protobuf/empty.proto");
  });

  test("payload type arguments contribute messages without rpcs", () => {
    const proto = protoFor(`
      import { grpcSchema } from "./src/index.ts";

      interface Tick {
        /** @fieldNumber 1 */
        at: number;
      }

      export const proto = grpcSchema<[Tick]>();
    `);

    expect(proto).toContain("message Tick {");
    expect(proto).not.toContain("service");
  });

  test("an object type with no methods warns that it describes no rpc", () => {
    const warnings: string[] = [];
    transformSource({
      path: "test.ts",
      contents: `
        import { grpcSchema } from "./src/index.ts";

        interface EmptyService {
          /** @fieldNumber 1 */
          name: string;
        }

        export const proto = grpcSchema<[EmptyService]>();
      `,
      logger: {
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
        info: () => {},
        trace: () => {},
      },
    });

    expect(
      warnings.some((w) =>
        w.includes("no methods found on object type 'EmptyService' for grpcSchema")
      )
    ).toBe(true);
  });

  test("indent is a runtime option, not baked into the module", () => {
    expect(protoFor(GREETER, "    ")).toContain("    string name = 1;");
  });
});

describe("generateGrpcSchemaCode", () => {
  const message = (name: string, field: string) => ({
    id: `t_${name}`,
    kind: "object" as const,
    name,
    properties: [
      {
        name: field,
        type: { id: "t_str", kind: "primitive" as const, type: "string" as const },
        optional: false,
        readonly: false,
        fieldNumber: 1,
      },
    ],
  });

  test("a missing field number blocks generation at the callsite", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "grpc",
          address: { protocol: "grpc", service: "Svc", method: "Do" },
          request: {
            protocol: "grpc",
            message: {
              id: "t_req",
              kind: "object",
              name: "Req",
              properties: [
                {
                  name: "id",
                  type: { id: "t_str", kind: "primitive", type: "string" },
                  optional: false,
                  readonly: false,
                },
              ],
            },
            streaming: false,
          },
          responses: [
            { protocol: "grpc", message: message("Res", "ok"), streaming: false },
          ],
        },
      ],
    };

    const mod = evalModule<{ grpcSchema: () => string }>(
      generateGrpcSchemaCode([], service)
    );
    expect(() => mod.grpcSchema()).toThrow("@fieldNumber");
  });

  test("two packages in one file is refused, since proto allows one", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "grpc",
          address: { protocol: "grpc", package: "a", service: "A", method: "Do" },
          request: { protocol: "grpc", message: message("Req", "id"), streaming: false },
          responses: [
            { protocol: "grpc", message: message("Res", "ok"), streaming: false },
          ],
        },
        {
          kind: "serviceMethod",
          protocol: "grpc",
          address: { protocol: "grpc", package: "b", service: "B", method: "Do" },
          request: { protocol: "grpc", message: message("Req", "id"), streaming: false },
          responses: [
            { protocol: "grpc", message: message("Res", "ok"), streaming: false },
          ],
        },
      ],
    };

    const mod = evalModule<{ grpcSchema: () => string }>(
      generateGrpcSchemaCode([], service)
    );
    expect(() => mod.grpcSchema()).toThrow("conflicting proto packages");
  });

  test("a non-message payload is refused with the slot named", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "grpc",
          address: { protocol: "grpc", service: "Svc", method: "Count" },
          request: {
            protocol: "grpc",
            message: { id: "t_num", kind: "primitive", type: "number" },
            streaming: false,
          },
          responses: [
            { protocol: "grpc", message: message("Res", "ok"), streaming: false },
          ],
        },
      ],
    };

    const mod = evalModule<{ grpcSchema: () => string }>(
      generateGrpcSchemaCode([], service)
    );
    expect(() => mod.grpcSchema()).toThrow("request of rpc 'Svc.Count'");
  });

  test("several rpcs on one service share a block, in order", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: ["First", "Second"].map((method) => ({
        kind: "serviceMethod" as const,
        protocol: "grpc" as const,
        address: { protocol: "grpc" as const, service: "Svc", method },
        request: {
          protocol: "grpc" as const,
          message: message("Req", "id"),
          streaming: false,
        },
        responses: [
          {
            protocol: "grpc" as const,
            message: message("Res", "ok"),
            streaming: false,
          },
        ],
      })),
    };

    const proto = evalModule<{ grpcSchema: (o?: any) => string }>(
      generateGrpcSchemaCode([], service)
    ).grpcSchema();

    expect(proto.match(/service Svc \{/g)).toHaveLength(1);
    expect(proto.indexOf("rpc First")).toBeLessThan(proto.indexOf("rpc Second"));
  });

  test("a deprecated method carries the option into the rpc body", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "grpc",
          address: { protocol: "grpc", service: "Svc", method: "Old" },
          deprecated: true,
          request: { protocol: "grpc", message: message("Req", "id"), streaming: false },
          responses: [
            { protocol: "grpc", message: message("Res", "ok"), streaming: false },
          ],
        },
      ],
    };

    const proto = evalModule<{ grpcSchema: (o?: any) => string }>(
      generateGrpcSchemaCode([], service)
    ).grpcSchema();

    expect(proto).toContain("rpc Old (Req) returns (Res) {");
    expect(proto).toContain("option deprecated = true;");
    expect(
      protobuf.parse(proto, { keepCase: true }).root.lookupService("Svc").methods["Old"]
    ).toBeDefined();
  });
});
