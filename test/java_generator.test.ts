// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateJavaFiles, generateJavaModels, javaGenerator } from "../src/generators/java.ts";
import { generate } from "../src/generators/generator.ts";
import { extractApiIR } from "../src/extractors/openapi.ts";
import type { TypeIR } from "../src/ir/types.ts";

describe("Java Generator (models and Jakarta client)", () => {
  const userIR: TypeIR = {
    id: "User",
    name: "User",
    kind: "object",
    properties: [
      {
        name: "id",
        type: { id: "p1", kind: "primitive", type: "string" },
        optional: false,
        readonly: true,
      },
      {
        name: "age",
        type: { id: "p2", kind: "primitive", type: "number" },
        optional: true,
        readonly: false,
        constraints: [{ kind: "minimum", value: 18 }, { kind: "maximum", value: 120 }],
      },
      {
        name: "email",
        type: { id: "p3", kind: "primitive", type: "string" },
        optional: true,
        readonly: false,
        constraints: [{ kind: "pattern", value: "^.+@.+$" }],
      },
      {
        name: "tags",
        type: {
          id: "p4",
          kind: "array",
          element: { id: "p5", kind: "primitive", type: "string" },
        },
        optional: true,
        readonly: false,
        constraints: [{ kind: "minItems", value: 1 }],
      },
    ],
  };

  const statusEnumIR: TypeIR = {
    id: "Status",
    name: "Status",
    kind: "enum",
    members: [
      { name: "ACTIVE", value: "active" },
      { name: "PENDING", value: "pending" },
    ],
  };

  test("generates Java Record by default with Jackson and Validation annotations on by default", () => {
    const files = generateJavaModels(
      [
        ["User", userIR],
        ["Status", statusEnumIR],
      ],
      {
        package: "com.example.model",
      }
    );

    expect(Object.keys(files).sort()).toEqual(["Status.java", "User.java"]);

    const userSource = files["User.java"]!;
    expect(userSource).toContain("package com.example.model;");
    expect(userSource).toContain("public record User(");
    expect(userSource).toContain('@JsonProperty("id") @jakarta.validation.constraints.NotNull String id');
    expect(userSource).toContain('@JsonProperty("age") @jakarta.validation.constraints.Min(18) @jakarta.validation.constraints.Max(120) Double age');
    expect(userSource).toContain('@JsonProperty("email") @jakarta.validation.constraints.Pattern(regexp = "^.+@.+$") String email');
    expect(userSource).toContain('@JsonProperty("tags") @jakarta.validation.constraints.Size(min = 1) java.util.List<String> tags');

    const statusSource = files["Status.java"]!;
    expect(statusSource).toContain("public enum Status {");
    expect(statusSource).toContain('ACTIVE("active")');
    expect(statusSource).toContain("@JsonValue");
    expect(statusSource).toContain("@JsonCreator");
  });

  test("generates POJO with getters, setters, and constructors when lombok is false", () => {
    const files = generateJavaModels([["User", userIR]], {
      style: "pojo",
      package: "com.example.model",
      lombok: false,
    });

    const source = files["User.java"]!;
    expect(source).toContain("public class User {");
    expect(source).toContain("private String id;");
    expect(source).toContain("public User() {}");
    expect(source).toContain("public User(String id, Double age, String email, java.util.List<String> tags)");
    expect(source).toContain("public String getId()");
    expect(source).toContain("public void setId(String id)");
  });

  test("generates POJO with Lombok and @Jacksonized annotations when lombok is enabled", () => {
    const files = generateJavaModels([["User", userIR]], {
      style: "pojo",
      package: "com.example.model",
      lombok: true,
    });

    const source = files["User.java"]!;
    expect(source).toContain("@Data");
    expect(source).toContain("@Builder");
    expect(source).toContain("@NoArgsConstructor");
    expect(source).toContain("@AllArgsConstructor");
    expect(source).toContain("@Jacksonized");
    expect(source).toContain("import lombok.extern.jackson.Jacksonized;");
    // Explicit getters/setters/constructors must be skipped
    expect(source).not.toContain("public String getId()");
    expect(source).not.toContain("public void setId(");
    expect(source).not.toContain("public User(");
  });

  test("allows explicitly disabling Jackson and Validation annotations", () => {
    const files = generateJavaModels([["User", userIR]], {
      style: "record",
      package: "com.example.model",
      jackson: false,
      validation: false,
    });

    const source = files["User.java"]!;
    expect(source).not.toContain("@JsonProperty");
    expect(source).not.toContain("@jakarta.validation");
  });

  test("generates Jakarta REST client by default when generating from ApiIR", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "PetStore", version: "1.0.0" },
      components: {
        schemas: {
          Pet: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            responses: {
              "200": {
                description: "List of pets",
                content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });
    const files = generate(
      ir,
      javaGenerator,
      {
        package: "com.petstore.api",
      },
      { trace: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    );

    expect(Object.keys(files).sort()).toEqual(["Pet.java", "PetStoreClient.java"]);
    const clientSource = files["PetStoreClient.java"]!;
    expect(clientSource).toContain("package com.petstore.api;");
    expect(clientSource).toContain("public class PetStoreClient implements java.lang.AutoCloseable");
    expect(clientSource).toContain("import jakarta.ws.rs.client.ClientBuilder;");
    expect(clientSource).toContain("public java.util.List<Pet> listPets(");
    expect(clientSource).toContain("new GenericType<java.util.List<Pet>>() {}");
  });

  test("client emission can be disabled with client: 'off' or client: false", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "PetStore", version: "1.0.0" },
      components: {
        schemas: {
          Pet: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });
    const files = generate(
      ir,
      javaGenerator,
      {
        package: "com.petstore.api",
        client: "off",
      },
      { trace: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    );

    expect(Object.keys(files)).toEqual(["Pet.java"]);
  });
});
