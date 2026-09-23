// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateJavaFiles, generateJavaModels, javaGenerator, toJavaType, mimetypeToSuffix } from "../src/generators/java.ts";
import { generate } from "../src/generators/generator.ts";
import { extractApiIR } from "../src/extractors/openapi.ts";
import type { TypeIR } from "../src/ir/types.ts";

describe("Java Generator (models, Jakarta client, MicroProfile client, package and service overrides)", () => {
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

  test("honors service.package fallback and explicit package overrides (modelPackage, clientPackage, serviceName, clientName)", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "PetStore", version: "1.0.0" },
      "x-package": "com.default.pkg",
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
            operationId: "getPets",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });

    // Test 1: Service.package is honored when options.package is omitted
    const defaultPkgFiles = generate(ir, javaGenerator, {});
    expect(defaultPkgFiles["Pet.java"]).toContain("package com.default.pkg;");
    expect(defaultPkgFiles["PetStoreClient.java"]).toContain("package com.default.pkg;");

    // Test 2: Separate modelPackage and clientPackage + serviceName override
    const separatedFiles = generate(ir, javaGenerator, {
      modelPackage: "com.example.model",
      clientPackage: "com.example.client",
      serviceName: "CustomService",
    });

    expect(separatedFiles["Pet.java"]).toContain("package com.example.model;");
    expect(separatedFiles["CustomServiceClient.java"]).toBeDefined();
    const clientContent = separatedFiles["CustomServiceClient.java"]!;
    expect(clientContent).toContain("package com.example.client;");
    expect(clientContent).toContain("import com.example.model.*;");

    // Test 3: clientName explicit override
    const customClientFiles = generate(ir, javaGenerator, {
      package: "com.acme",
      clientName: "AcmeApi",
    });
    expect(customClientFiles["AcmeApi.java"]).toBeDefined();
    expect(customClientFiles["AcmeApi.java"]).toContain("public class AcmeApi implements java.lang.AutoCloseable");
  });

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
    expect(source).toContain("public User(String id, Double age)");
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
    expect(source).not.toContain("public String getId()");
    expect(source).not.toContain("public void setId(");
    expect(source).not.toContain("public User(");
  });

  test("generates MicroProfile REST client interface with @RegisterRestClient when client is 'mp'", () => {
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
        "/pets/{petId}": {
          get: {
            operationId: "getPet",
            parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "200": {
                description: "A pet",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
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
        client: "mp",
      },
      { trace: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    );

    expect(Object.keys(files).sort()).toEqual(["Pet.java", "PetStoreClient.java"]);
    const clientSource = files["PetStoreClient.java"]!;
    expect(clientSource).toContain("import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;");
    expect(clientSource).toContain("@RegisterRestClient");
    expect(clientSource).toContain("public interface PetStoreClient {");
    expect(clientSource).toContain('@GET');
    expect(clientSource).toContain('@Path("/pets/{petId}")');
    expect(clientSource).toContain('@Produces("application/json")');
    expect(clientSource).toContain('Pet getPet(@PathParam("petId") String petId);');
  });

  describe("toJavaType", () => {
    const typeNameMap = new Map<string, string>();

    test("maps primitive types correctly", () => {
      expect(toJavaType({ id: "1", kind: "primitive", type: "string" }, typeNameMap)).toBe("String");
      expect(toJavaType({ id: "2", kind: "primitive", type: "number" }, typeNameMap)).toBe("Double");
      expect(toJavaType({ id: "3", kind: "primitive", type: "boolean" }, typeNameMap)).toBe("Boolean");
      expect(toJavaType({ id: "4", kind: "primitive", type: "bigint" }, typeNameMap)).toBe("Long");
      expect(toJavaType({ id: "5", kind: "primitive", type: "date" }, typeNameMap)).toBe("java.time.OffsetDateTime");
      expect(toJavaType({ id: "6", kind: "primitive", type: "null" }, typeNameMap)).toBe("Object");
      expect(toJavaType({ id: "7", kind: "primitive", type: "undefined" }, typeNameMap)).toBe("Void");
      expect(toJavaType({ id: "8", kind: "primitive", type: "void" }, typeNameMap)).toBe("Void");
      expect(toJavaType({ id: "9", kind: "primitive", type: "unknown" }, typeNameMap)).toBe("Object");
      expect(toJavaType({ id: "10", kind: "primitive", type: "any" }, typeNameMap)).toBe("Object");
      expect(toJavaType({ id: "11", kind: "primitive", type: "never" }, typeNameMap)).toBe("Object");
    });
  });

  describe("mimetypeToSuffix", () => {
    test("derives correct suffixes", () => {
      expect(mimetypeToSuffix("application/json")).toBe("AsJson");
      expect(mimetypeToSuffix("application/xml")).toBe("AsXml");
      expect(mimetypeToSuffix("application/yaml")).toBe("AsYaml");
      expect(mimetypeToSuffix("text/csv")).toBe("AsCsv");
      expect(mimetypeToSuffix("application/octet-stream")).toBe("AsOctetStream");
      expect(mimetypeToSuffix("multipart/form-data")).toBe("AsFormData");
      expect(mimetypeToSuffix("application/x-www-form-urlencoded")).toBe("AsUrlEncoded");
      expect(mimetypeToSuffix("text/plain")).toBe("AsText");
      expect(mimetypeToSuffix("image/png")).toBe("AsImagePng");
    });
  });
});
