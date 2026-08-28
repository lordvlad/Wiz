import { describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wizPlugin } from "../src/plugin.ts";

// Register plugin globally for Bun runtime
plugin(wizPlugin());

describe("wizPlugin End-to-End", () => {
  test("transforms and executes keysOf, requiredKeysOf, optionalKeysOf, schema, validate, is", async () => {
    // Dynamically import fixture module transformed by plugin
    const fixture = await import("./fixtures/userFixture.ts");

    expect(fixture.userKeys).toEqual(["id", "name", "age", "email"]);
    expect(fixture.userReqKeys).toEqual(["id", "name", "email"]);
    expect(fixture.userOptKeys).toEqual(["age"]);

    // Generated documents are typed `Record<string, unknown>`; tests assert on
    // their concrete generated shape.
    const userSchema = fixture.userSchema as Record<string, any>;
    expect(userSchema).toBeDefined();
    expect(userSchema.$schema).toContain("draft/2020-12");
    expect(userSchema.properties.name.minLength).toBe(2);

    // Test openapiSchema
    const apiDoc = fixture.apiOpenApiSchema as Record<string, any>;
    expect(apiDoc).toBeDefined();
    expect(apiDoc.openapi).toBe("3.0.3");
    expect(apiDoc.info.server).toBe("http://books.com");
    expect(apiDoc.components.schemas.User).toBeDefined();
    expect(apiDoc.components.schemas.Book).toBeDefined();
    // Test valid user
    const validUser = {
      id: "u123",
      name: "Alice",
      age: 28,
      email: "alice@example.com",
    };
    expect(fixture.checkUserIs(validUser)).toBe(true);
    expect(fixture.checkUserValidate(validUser)).toEqual([]);

    // Test invalid user
    const invalidUser = {
      id: "u123",
      name: "A", // too short (minLength 2)
      age: -5, // too small (min 0)
      email: "invalid-email",
    };
    expect(fixture.checkUserIs(invalidUser)).toBe(false);
    const errors = fixture.checkUserValidate(invalidUser);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    // Test protobuf encode/decode
    const protoObj = { id: 100, name: "Bob" };
    const buf = new Uint8Array(1024);
    const bytesWritten = fixture.encodeProtoUser(protoObj, buf);
    expect(bytesWritten).toBeGreaterThan(0);

    const decodedProto = fixture.decodeProtoUser(buf.subarray(0, bytesWritten));
    expect(decodedProto).toEqual(protoObj);
    // Test protobufSchema
    expect(fixture.protoSchemaString).toBeDefined();
    expect(fixture.protoSchemaString).toContain('syntax = "proto3";');
    expect(fixture.protoSchemaString).toContain("message ProtoUser {");
    // @format int32 narrows the JS number; without it a number is a double.
    expect(fixture.protoSchemaString).toContain("int32 id = 1;");
    expect(fixture.protoSchemaString).toContain("string name = 2;");
  });

  test("deduplicates virtual modules across different files", async () => {
    const f1 = await import("./fixtures/mod1.ts");
    const f2 = await import("./fixtures/mod2.ts");

    expect(f1.getKeys()).toEqual(["id", "title"]);
    expect(f2.getKeys()).toEqual(["id", "title"]);

    // Both should validate identically
    expect(f1.validateItem({ id: "1", title: "Item 1" })).toEqual([]);
    expect(f2.validateItem({ id: "1", title: "Item 1" })).toEqual([]);
  });
  test("works with Bun.build bundler pipeline", async () => {
    const outdir = await mkdtemp(join(tmpdir(), "wiz-plugin-build-"));
    try {
      const buildOutput = await Bun.build({
        entrypoints: ["./test/fixtures/userFixture.ts"],
        plugins: [wizPlugin()],
        outdir,
      });

      expect(buildOutput.success).toBe(true);
      expect(buildOutput.outputs.length).toBeGreaterThan(0);

      // The bundle is imported rather than pattern-matched: what matters is
      // that the built artifact still answers correctly, not how Bun happened
      // to name its variables. The specifier cannot be static — it is a build
      // artifact in a temp directory that exists only while this test runs.
      const built = await import(buildOutput.outputs[0]!.path);
      expect(built.userKeys).toEqual(["id", "name", "age", "email"]);
      expect(built.checkUserIs({ id: "u1", name: "Ada", email: "a@b.co" })).toBe(
        true
      );
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });
});
