// @wiz-ignore
import { describe, expect, test } from "bun:test";
import {
  generateProtobufCode,
  generateProtobufSchemaCode,
} from "../src/generators/protobuf.ts";
import { getIRForSource } from "./helpers.ts";

describe("Protobuf Generator", () => {
  test("encodes and decodes an object with @fieldNumber tags", () => {
    const ir = getIRForSource(
      `
      export interface User {
        /** @fieldNumber 1 */
        id: number;
        /** @fieldNumber 2 */
        name: string;
        /** @fieldNumber 3 */
        active: boolean;
        /** @fieldNumber 4 */
        tags?: string[];
      }
    `,
      "User"
    );

    const protoCode = generateProtobufCode(ir);
    const codeWithoutExport = protoCode.replace(/export /g, "");
    const fnModule = new Function(
      `${codeWithoutExport}\nreturn { encodeProto, decodeProto };`
    )();

    const originalUser = {
      id: 42,
      name: "Alice",
      active: true,
      tags: ["admin", "dev"],
    };

    const buf = new Uint8Array(1024);
    const bytesWritten = fnModule.encodeProto(originalUser, buf);
    expect(bytesWritten).toBeGreaterThan(0);

    const decodedUser = fnModule.decodeProto(buf.subarray(0, bytesWritten));
    expect(decodedUser).toEqual(originalUser);
  });
  test("throws error if @fieldNumber is missing on a property when encode/decode is called", () => {
    const ir = getIRForSource(
      `
      export interface InvalidUser {
        /** @fieldNumber 1 */
        id: number;
        name: string; // Missing @fieldNumber!
      }
    `,
      "InvalidUser"
    );

    const protoCode = generateProtobufCode(ir);
    const codeWithoutExport = protoCode.replace(/export /g, "");
    const fnModule = new Function(
      `${codeWithoutExport}\nreturn { encodeProto, decodeProto };`
    )();

    const invalidUser = { id: 1, name: "Alice" };
    const buf = new Uint8Array(1024);

    expect(() => fnModule.encodeProto(invalidUser, buf)).toThrow(
      "[wiz] Property 'name' on type 'InvalidUser' is missing required '@fieldNumber <N>' JSDoc tag"
    );
    expect(() => fnModule.decodeProto(buf)).toThrow(
      "[wiz] Property 'name' on type 'InvalidUser' is missing required '@fieldNumber <N>' JSDoc tag"
    );
  });
  test("generates protobuf schema string with custom indent and transitive types", () => {
    const userIR = getIRForSource(
      `
      export interface Book {
        /** @fieldNumber 1 */
        id: number;
        /** @fieldNumber 2 */
        title: string;
      }
      export interface User {
        /** @fieldNumber 1 */
        id: number;
        /** @fieldNumber 2 */
        books: Book[];
      }
    `,
      "User"
    );

    const schemaCode = generateProtobufSchemaCode([{ name: "User", ir: userIR }]);
    const codeWithoutExport = schemaCode.replace(/export /g, "");
    const fnModule = new Function(`${codeWithoutExport}\nreturn protobufSchema;`)();

    const protoStr = fnModule({ indent: "    " });
    expect(protoStr).toContain('syntax = "proto3";');
    // A plain `number` is a double; `@format int32` opts into a compact int.
    expect(protoStr).toContain('message User {\n    double id = 1;\n    repeated Book books = 2;\n}');
    expect(protoStr).toContain('message Book {\n    double id = 1;\n    string title = 2;\n}');
  });
  test("includes description, constraints, and options in protobuf schema string", () => {
    const ir = getIRForSource(
      `
      /**
       * User account record
       */
      export interface UserAccount {
        /**
         * Unique ID
         * @minimum 1
         * @fieldNumber 1
         */
        id: number;

        /**
         * User full name
         * @minLength 2
         * @fieldNumber 2
         */
        name: string;

        /**
         * Legacy email field
         * @deprecated Use newEmail instead
         * @fieldNumber 3
         */
        oldEmail?: string;
      }
    `,
      "UserAccount"
    );

    const schemaCode = generateProtobufSchemaCode([{ name: "UserAccount", ir }]);
    const codeWithoutExport = schemaCode.replace(/export /g, "");
    const fnModule = new Function(`${codeWithoutExport}\nreturn protobufSchema;`)();

    const protoStr = fnModule({ indent: "  " });
    expect(protoStr).toContain("// User account record");
    expect(protoStr).toContain("// Unique ID");
    expect(protoStr).toContain("// @minimum 1");
    expect(protoStr).toContain("double id = 1;");
    expect(protoStr).toContain("// User full name");
    expect(protoStr).toContain("// @minLength 2");
    expect(protoStr).toContain("string name = 2;");
    expect(protoStr).toContain("// Legacy email field");
    expect(protoStr).toContain("string oldEmail = 3 [deprecated = true];");
  });
});
