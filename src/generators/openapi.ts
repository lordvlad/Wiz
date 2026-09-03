import {
  collectNamedTypes,
  isUserNamedType,
  type Annotated,
  type Constraint,
  type TypeIR,
} from "../types.ts";
import {
  annotationsToKeywords,
  constraintsToKeywords,
} from "../openapiDialect.ts";
import {
  emptyService,
  isHttpMethod,
  type HttpServiceMethodIR,
  type ParameterIR,
  type ServiceIR,
  type ServiceMethodBodyIR,
} from "../ir/service.ts";
import { assertValidSpecDocumentSync } from "../validators/jsonSchema.ts";

function applyConstraints(
  schema: Record<string, unknown>,
  constraints: Constraint[] | undefined,
  version: "3.0" | "3.1"
) {
  Object.assign(schema, constraintsToKeywords(constraints, version));
}

function applyAnnotations(
  schema: Record<string, unknown>,
  node: Annotated,
  version: "3.0" | "3.1"
) {
  Object.assign(schema, annotationsToKeywords(node, version));
}

export function irToOpenApiSchema(
  ir: TypeIR,
  version: "3.0" | "3.1",
  isRoot = false
): Record<string, unknown> {
  if (!isRoot && isUserNamedType(ir.name)) {
    return { $ref: `#/components/schemas/${ir.name}` };
  }

  const schema: Record<string, unknown> = {};

  if (ir.description) {
    schema.description = ir.description;
  }

  if (ir.deprecated?.isDeprecated) {
    schema.deprecated = true;
    if (ir.deprecated.note && version === "3.0" && !schema.description) {
      schema.description = `[DEPRECATED: ${ir.deprecated.note}]`;
    }
  }

  applyConstraints(schema, ir.constraints, version);
  applyAnnotations(schema, ir, version);

  switch (ir.kind) {
    case "primitive": {
      switch (ir.type) {
        case "string":
          schema.type = "string";
          break;
        case "number":
          schema.type = "number";
          break;
        case "boolean":
          schema.type = "boolean";
          break;
        case "bigint":
          // JSON numbers are doubles in practice, and `JSON.stringify` refuses
          // BigInt outright, so a 64-bit integer can only travel as a string.
          // This is the same choice proto3's canonical JSON mapping makes, and
          // what protoc-gen-openapi emits for int64.
          schema.type = "string";
          schema.format = "int64";
          schema.pattern = "^-?\\d+$";
          break;
        case "bytes":
          schema.type = "string";
          // 3.0 has `format: byte`; 3.1 defers to JSON Schema's contentEncoding.
          if (version === "3.0") {
            schema.format = "byte";
          } else {
            schema.contentEncoding = "base64";
          }
          break;
        case "date":
          schema.type = "string";
          schema.format = "date-time";
          break;
        case "null":
          if (version === "3.0") {
            schema.nullable = true;
          } else {
            schema.type = "null";
          }
          break;
        case "undefined":
        case "void":
        case "never":
          break;
        case "unknown":
        case "any":
          break;
        case "symbol":
          schema.type = "string";
          break;
      }
      break;
    }

    case "literal": {
      if (typeof ir.value === "bigint") {
        schema.type = "string";
        schema.format = "int64";
        schema.enum = [ir.value.toString()];
      } else {
        if (version === "3.1") {
          schema.const = ir.value;
        } else {
          schema.type = typeof ir.value;
          schema.enum = [ir.value];
        }
      }
      break;
    }

    case "enum": {
      const firstVal = ir.members[0]?.value;
      if (typeof firstVal === "number") {
        schema.type = "number";
      } else {
        schema.type = "string";
      }
      schema.enum = ir.members.map((m) => m.value);
      break;
    }

    case "object": {
      schema.type = "object";
      const propertiesSchema: Record<string, unknown> = {};
      const required: string[] = [];

      for (const prop of ir.properties) {
        const propSchema = irToOpenApiSchema(prop.type, version, false);
        if (prop.description) {
          propSchema.description = prop.description;
        }
        if (prop.deprecated?.isDeprecated) {
          propSchema.deprecated = true;
        }
        if (prop.readonly) {
          propSchema.readOnly = true;
        }
        applyConstraints(propSchema, prop.constraints, version);
        applyAnnotations(propSchema, prop, version);
        propertiesSchema[prop.name] = propSchema;

        if (!prop.optional) {
          required.push(prop.name);
        }
      }

      schema.properties = propertiesSchema;
      if (required.length > 0) {
        schema.required = required;
      }

      if (ir.additionalProperties !== undefined) {
        if (typeof ir.additionalProperties === "boolean") {
          schema.additionalProperties = ir.additionalProperties;
        } else {
          schema.additionalProperties = irToOpenApiSchema(
            ir.additionalProperties,
            version,
            false
          );
        }
      }
      break;
    }

    case "array": {
      schema.type = "array";
      schema.items = irToOpenApiSchema(ir.element, version, false);
      break;
    }

    case "tuple": {
      schema.type = "array";
      if (version === "3.1") {
        schema.prefixItems = ir.elements.map((e) =>
          irToOpenApiSchema(e.type, version, false)
        );
        if (ir.rest) {
          schema.items = irToOpenApiSchema(ir.rest, version, false);
        }
      } else {
        schema.items = ir.elements.map((e) =>
          irToOpenApiSchema(e.type, version, false)
        );
      }
      break;
    }

    case "union": {
      // `undefined`/`void` members encode *absence*, which OpenAPI expresses
      // through `required`, not through the schema. Only `null` is nullability.
      const present = ir.types.filter(
        (t) =>
          !(
            t.kind === "primitive" &&
            (t.type === "undefined" || t.type === "void")
          )
      );
      const nonNull = present.filter(
        (t) => !(t.kind === "primitive" && t.type === "null")
      );
      const nullable = present.length > nonNull.length;

      if (nonNull.length === 0) {
        return version === "3.0"
          ? { ...schema, nullable: true }
          : { ...schema, type: "null" };
      }

      // A lone meaningful member collapses to that member's own schema.
      if (nonNull.length === 1) {
        const base = irToOpenApiSchema(nonNull[0]!, version, false);
        if (!nullable) return { ...schema, ...base };
        if (version === "3.0") return { ...schema, ...base, nullable: true };
        return typeof base.type === "string"
          ? { ...schema, ...base, type: [base.type, "null"] }
          : { ...schema, anyOf: [base, { type: "null" }] };
      }

      const members = nonNull.map((t) => irToOpenApiSchema(t, version, false));
      if (nullable && version === "3.1") members.push({ type: "null" });

      if (ir.discriminator) {
        schema.oneOf = members;
        schema.discriminator = { propertyName: ir.discriminator.propertyName };
      } else {
        schema.anyOf = members;
      }
      if (nullable && version === "3.0") schema.nullable = true;
      break;
    }

    case "intersection": {
      schema.allOf = ir.types.map((t) => irToOpenApiSchema(t, version, false));
      break;
    }

    case "record": {
      schema.type = "object";
      schema.additionalProperties = irToOpenApiSchema(
        ir.valueType,
        version,
        false
      );
      break;
    }

    case "ref": {
      schema.$ref = `#/components/schemas/${ir.name ?? ir.targetId}`;
      break;
    }
  }

  return schema;
}

/** `never`/`void`/`undefined` in a slot means "this method has none". */
function isAbsentIR(ir: TypeIR | undefined): boolean {
  if (!ir) return true;
  return (
    ir.kind === "primitive" &&
    (ir.type === "never" || ir.type === "void" || ir.type === "undefined")
  );
}

function parametersFor(
  parameters: ParameterIR[] | undefined,
  version: "3.0" | "3.1"
): Record<string, unknown>[] {
  if (!parameters) return [];
  const emitted: Record<string, unknown>[] = [];
  for (const p of parameters) {
    if (isAbsentIR(p.type)) continue;
    const param: Record<string, unknown> = {
      name: p.name,
      in: p.in,
      // Path parameters are always required per the OpenAPI spec.
      required: p.in === "path" ? true : p.required,
      schema: irToOpenApiSchema(p.type, version, false),
    };
    if (p.description) param.description = p.description;
    if (p.deprecated) param.deprecated = true;
    emitted.push(param);
  }
  return emitted;
}

/** `{ "application/json": { schema } }` for each media type on a payload. */
function contentFor(
  bodies: ServiceMethodBodyIR[] | undefined,
  version: "3.0" | "3.1"
): Record<string, unknown> | undefined {
  if (!bodies || bodies.length === 0) return undefined;
  const content: Record<string, unknown> = {};
  for (const body of bodies) {
    if (isAbsentIR(body.content)) continue;
    content[body.mimetype] = {
      schema: irToOpenApiSchema(body.content, version, false),
    };
  }
  return Object.keys(content).length > 0 ? content : undefined;
}

/**
 * Renders one operation object. Generated fields come first so that an explicit
 * override (`description`, or even a hand-written `responses`) wins.
 */
function operationSource(
  method: HttpServiceMethodIR,
  version: "3.0" | "3.1"
): string {
  const operation: Record<string, unknown> = {};

  if (method.tags) operation.tags = method.tags;
  if (method.summary) operation.summary = method.summary;
  if (method.description) operation.description = method.description;
  if (method.operationId) operation.operationId = method.operationId;
  if (method.deprecated) operation.deprecated = true;

  const parameters = parametersFor(method.request.parameters, version);
  if (parameters.length > 0) operation.parameters = parameters;

  const requestContent = contentFor(method.request.body, version);
  if (requestContent) {
    operation.requestBody = {
      required: method.request.bodyRequired ?? true,
      content: requestContent,
    };
  }

  const responses: Record<string, unknown> = {};
  for (const response of method.responses) {
    const content = contentFor(response.body, version);
    const headers: Record<string, unknown> = {};
    for (const header of response.headers ?? []) {
      if (isAbsentIR(header.type)) continue;
      const entry: Record<string, unknown> = {
        schema: irToOpenApiSchema(header.type, version, false),
      };
      if (header.description) entry.description = header.description;
      if (header.required) entry.required = true;
      if (header.deprecated) entry.deprecated = true;
      headers[header.name] = entry;
    }
    responses[String(response.status)] = {
      description:
        response.description ?? (content ? "Successful response" : "No content"),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(content ? { content } : {}),
    };
  }
  operation.responses = responses;

  const generated = JSON.stringify(operation, null, 2);
  return method.overrides
    ? `{ ...${generated}, ...(${method.overrides}) }`
    : generated;
}

function pathsSource(service: ServiceIR, version: "3.0" | "3.1"): string {
  const byPath = new Map<string, Array<[string, string]>>();
  for (const method of service.methods) {
    // An OpenAPI document describes HTTP. A gRPC method has no path and no
    // verb, so there is nothing here to render it as; the client generator is
    // where it belongs.
    if (!isHttpMethod(method)) continue;
    const entries = byPath.get(method.address.path) ?? [];
    entries.push([
      method.address.method.toLowerCase(),
      operationSource(method, version),
    ]);
    byPath.set(method.address.path, entries);
  }

  const pathEntries = [...byPath.entries()].map(([path, methods]) => {
    const methodEntries = methods
      .map(([method, src]) => `    ${JSON.stringify(method)}: ${src}`)
      .join(",\n");
    return `  ${JSON.stringify(path)}: {\n${methodEntries}\n  }`;
  });

  return `{\n${pathEntries.join(",\n")}\n}`;
}

/** Every TypeIR a method references, for component hoisting. */
function typesReferencedBy(method: HttpServiceMethodIR): TypeIR[] {
  const referenced: TypeIR[] = [];
  const { request } = method;
  for (const p of request.parameters ?? []) referenced.push(p.type);
  for (const body of request.body ?? []) referenced.push(body.content);
  for (const response of method.responses) {
    for (const body of response.body ?? []) referenced.push(body.content);
    for (const header of response.headers ?? []) referenced.push(header.type);
  }
  return referenced;
}

export function generateOpenApiSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>,
  version: "3.0" | "3.1",
  service: ServiceIR = emptyService()
): string {
  const schemasObj: Record<string, unknown> = {};
  const allNamedTypes = new Map<string, TypeIR>();

  const collect = (ir: TypeIR) => {
    for (const [name, namedIR] of collectNamedTypes(ir).entries()) {
      // A `ref` node only names its target; it is never the definition of it.
      if (namedIR.kind === "ref") continue;
      if (!allNamedTypes.has(name)) allNamedTypes.set(name, namedIR);
    }
  };

  // Declared names are claimed before anything is walked: a `$ref` to a later
  // entry would otherwise register that name as a self-referential stub.
  for (const { name, ir } of types) {
    if (!allNamedTypes.has(name)) allNamedTypes.set(name, ir);
  }
  for (const { ir } of types) collect(ir);

  // Method payload types contribute component schemas too, for the HTTP
  // methods this document can describe.
  for (const method of service.methods) {
    if (!isHttpMethod(method)) continue;
    for (const ir of typesReferencedBy(method)) collect(ir);
  }

  for (const [name, ir] of allNamedTypes.entries()) {
    schemasObj[name] = irToOpenApiSchema(ir, version, true);
  }

  const openapiVersion = version === "3.0" ? "3.0.3" : "3.1.0";
  const sampleDoc = {
    openapi: openapiVersion,
    info: { title: service.name ?? "OpenAPI Service", version: service.version ?? "1.0.0" },
    ...(version === "3.0" ? { paths: {} } : {}),
    components: { schemas: schemasObj }
  };
  assertValidSpecDocumentSync(sampleDoc, "OpenAPI");

  const buildDocument = [
    `function buildDocument(baseSchema = {}) {`,
    `  const components = baseSchema.components || {};`,
    `  const schemas = components.schemas || {};`,
    `  const basePaths = baseSchema.paths || {};`,
    `  const generatedPaths = ${pathsSource(service, version)};`,
    `  const paths = { ...basePaths };`,
    `  for (const pathKey of Object.keys(generatedPaths)) {`,
    `    paths[pathKey] = { ...(paths[pathKey] || {}), ...generatedPaths[pathKey] };`,
    `  }`,
    `  return {`,
    `    openapi: ${JSON.stringify(openapiVersion)},`,
    `    ...baseSchema,`,
    // 3.0 lists `paths` as required, so a components-only document still needs
    // it; 3.1 made it optional, and inventing one there would be noise.
    `    ...(Object.keys(paths).length > 0 || ${JSON.stringify(version === "3.0")} ? { paths } : {}),`,
    `    components: {`,
    `      ...components,`,
    `      schemas: {`,
    `        ...schemas,`,
    `        ...${JSON.stringify(schemasObj, null, 2)}`,
    `      }`,
    `    }`,
    `  };`,
    `}`,
  ].join("\n");

  return [
    buildDocument,
    ``,
    `export function openapiSchema(baseSchema = {}) {`,
    `  return buildDocument(baseSchema);`,
    `}`,
  ].join("\n");
}
