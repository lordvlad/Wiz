import {
  collectNamedTypes,
  flattenObjectProperties,
  isUserNamedType,
  type Constraint,
  type TypeIR,
} from "../types.ts";

function applyConstraints(
  schema: Record<string, unknown>,
  constraints?: Constraint[]
) {
  if (!constraints) return;
  for (const c of constraints) {
    schema[c.kind] = c.value;
  }
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

  applyConstraints(schema, ir.constraints);

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
          schema.type = "integer";
          schema.format = "int64";
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
        schema.type = "integer";
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
        applyConstraints(propSchema, prop.constraints);
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

/**
 * A single compile-time `openapiSchema.<method>()` call site.
 * `optionsSource` is verbatim JS from the callsite so literal option objects
 * survive into the generated document without being re-serialized.
 */
export interface OpenApiOperationIR {
  method: string;
  path: string;
  optionsSource?: string;
  pathParams?: TypeIR;
  queryParams?: TypeIR;
  response?: TypeIR;
  requestBody?: TypeIR;
  /** Success status code; defaults to 200, or 204 when there is no response. */
  status?: number;
}

/** `never`/`void`/`undefined` in a slot means "this operation has none". */
function isAbsentIR(ir: TypeIR | undefined): boolean {
  if (!ir) return true;
  return (
    ir.kind === "primitive" &&
    (ir.type === "never" || ir.type === "void" || ir.type === "undefined")
  );
}

function parametersFor(
  ir: TypeIR | undefined,
  location: "path" | "query",
  version: "3.0" | "3.1"
): Record<string, unknown>[] {
  if (isAbsentIR(ir)) return [];
  // Params often arrive as an intersection (`ExtractRouteParams` builds one per
  // segment), so members must be merged before reading properties.
  return flattenObjectProperties(ir!).map((p) => {
    const param: Record<string, unknown> = {
      name: p.name,
      in: location,
      // Path parameters are always required per the OpenAPI spec.
      required: location === "path" ? true : !p.optional,
      schema: irToOpenApiSchema(p.type, version, false),
    };
    if (p.description) param.description = p.description;
    if (p.deprecated?.isDeprecated) param.deprecated = true;
    return param;
  });
}

/**
 * Renders one operation object. Generated fields come first so that an explicit
 * option (`description`, or even a hand-written `responses`) overrides them.
 */
function operationSource(op: OpenApiOperationIR, version: "3.0" | "3.1"): string {
  const operation: Record<string, unknown> = {};

  const parameters = [
    ...parametersFor(op.pathParams, "path", version),
    ...parametersFor(op.queryParams, "query", version),
  ];
  if (parameters.length > 0) operation.parameters = parameters;

  if (!isAbsentIR(op.requestBody)) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: irToOpenApiSchema(op.requestBody!, version, false),
        },
      },
    };
  }

  const noBody = isAbsentIR(op.response);
  const status = String(op.status ?? (noBody ? 204 : 200));
  operation.responses = noBody
    ? { [status]: { description: "No content" } }
    : {
        [status]: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: irToOpenApiSchema(op.response!, version, false),
            },
          },
        },
      };

  const generated = JSON.stringify(operation, null, 2);
  return op.optionsSource
    ? `{ ...${generated}, ...(${op.optionsSource}) }`
    : generated;
}

function pathsSource(
  operations: OpenApiOperationIR[],
  version: "3.0" | "3.1"
): string {
  const byPath = new Map<string, Array<[string, string]>>();
  for (const op of operations) {
    const methods = byPath.get(op.path) ?? [];
    methods.push([op.method, operationSource(op, version)]);
    byPath.set(op.path, methods);
  }

  const pathEntries = [...byPath.entries()].map(([path, methods]) => {
    const methodEntries = methods
      .map(([method, src]) => `    ${JSON.stringify(method)}: ${src}`)
      .join(",\n");
    return `  ${JSON.stringify(path)}: {\n${methodEntries}\n  }`;
  });

  return `{\n${pathEntries.join(",\n")}\n}`;
}

export function generateOpenApiSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>,
  version: "3.0" | "3.1",
  operations: OpenApiOperationIR[] = []
): string {
  const schemasObj: Record<string, unknown> = {};
  const allNamedTypes = new Map<string, TypeIR>();

  const collect = (ir: TypeIR) => {
    for (const [name, namedIR] of collectNamedTypes(ir).entries()) {
      if (!allNamedTypes.has(name)) allNamedTypes.set(name, namedIR);
    }
  };

  for (const { name, ir } of types) {
    if (!allNamedTypes.has(name)) {
      allNamedTypes.set(name, ir);
    }
    collect(ir);
  }

  // Operation payload types contribute component schemas too.
  for (const op of operations) {
    for (const ir of [op.pathParams, op.queryParams, op.response, op.requestBody]) {
      if (ir) collect(ir);
    }
  }

  for (const [name, ir] of allNamedTypes.entries()) {
    schemasObj[name] = irToOpenApiSchema(ir, version, true);
  }

  const openapiVersion = version === "3.0" ? "3.0.3" : "3.1.0";

  const buildDocument = [
    `function buildDocument(baseSchema = {}) {`,
    `  const components = baseSchema.components || {};`,
    `  const schemas = components.schemas || {};`,
    `  const basePaths = baseSchema.paths || {};`,
    `  const generatedPaths = ${pathsSource(operations, version)};`,
    `  const paths = { ...basePaths };`,
    `  for (const pathKey of Object.keys(generatedPaths)) {`,
    `    paths[pathKey] = { ...(paths[pathKey] || {}), ...generatedPaths[pathKey] };`,
    `  }`,
    `  return {`,
    `    openapi: ${JSON.stringify(openapiVersion)},`,
    `    ...baseSchema,`,
    `    ...(Object.keys(paths).length > 0 ? { paths } : {}),`,
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
