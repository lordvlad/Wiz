import type { Annotated, Constraint, TypeIR } from "../types.ts";

function applyConstraints(schema: Record<string, unknown>, constraints?: Constraint[]) {
  if (!constraints) return;
  for (const c of constraints) {
    schema[c.kind] = c.value;
  }
}

/**
 * Descriptive keywords. `examples` is an array in every draft from 06 onward,
 * so both supported drafts take the same shape. `meta` is intentionally not
 * emitted: arbitrary JSDoc tags are not JSON Schema keywords.
 */
function applyAnnotations(schema: Record<string, unknown>, node: Annotated) {
  if (node.default !== undefined) schema.default = node.default;
  if (node.examples && node.examples.length > 0) schema.examples = node.examples;
}

export function irToJsonSchema(
  ir: TypeIR,
  draft: "draft-2020-12" | "draft-07"
): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  if (ir.description) {
    schema.description = ir.description;
  }

  if (ir.deprecated?.isDeprecated) {
    if (draft === "draft-2020-12") {
      schema.deprecated = true;
    } else {
      const note = ir.deprecated.note ? `: ${ir.deprecated.note}` : "";
      schema.description = schema.description
        ? `[DEPRECATED${note}] ${schema.description}`
        : `[DEPRECATED${note}]`;
    }
  }

  applyConstraints(schema, ir.constraints);
  applyAnnotations(schema, ir);

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
          schema.type = "null";
          break;
        case "undefined":
        case "void":
        case "never":
          schema.not = {};
          break;
        case "unknown":
        case "any":
          break;
        case "symbol":
          schema.type = "string";
          schema.title = "symbol";
          break;
      }
      break;
    }

    case "literal": {
      if (typeof ir.value === "bigint") {
        schema.type = "integer";
        schema.const = ir.value.toString();
      } else {
        schema.const = ir.value;
      }
      break;
    }

    case "enum": {
      schema.enum = ir.members.map((m) => m.value);
      break;
    }

    case "object": {
      schema.type = "object";
      const propertiesSchema: Record<string, unknown> = {};
      const required: string[] = [];

      for (const prop of ir.properties) {
        const propSchema = irToJsonSchema(prop.type, draft);
        if (prop.description) {
          propSchema.description = prop.description;
        }
        if (prop.deprecated?.isDeprecated) {
          if (draft === "draft-2020-12") {
            propSchema.deprecated = true;
          } else {
            const note = prop.deprecated.note ? `: ${prop.deprecated.note}` : "";
            propSchema.description = propSchema.description
              ? `[DEPRECATED${note}] ${propSchema.description}`
              : `[DEPRECATED${note}]`;
          }
        }
        applyConstraints(propSchema, prop.constraints);
        applyAnnotations(propSchema, prop);
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
          schema.additionalProperties = irToJsonSchema(ir.additionalProperties, draft);
        }
      }
      break;
    }

    case "array": {
      schema.type = "array";
      schema.items = irToJsonSchema(ir.element, draft);
      break;
    }

    case "tuple": {
      schema.type = "array";
      if (draft === "draft-2020-12") {
        schema.prefixItems = ir.elements.map((e) => irToJsonSchema(e.type, draft));
        if (ir.rest) {
          schema.items = irToJsonSchema(ir.rest, draft);
        } else {
          schema.items = false;
        }
      } else {
        schema.items = ir.elements.map((e) => irToJsonSchema(e.type, draft));
        if (ir.rest) {
          schema.additionalItems = irToJsonSchema(ir.rest, draft);
        } else {
          schema.additionalItems = false;
        }
      }
      break;
    }

    case "union": {
      // Optional properties surface as `T | undefined`. Absence is already
      // encoded by omission from `required`, so an `undefined` member would
      // only contribute a vacuous `{ "not": {} }` branch.
      const present = ir.types.filter(
        (t) =>
          !(
            t.kind === "primitive" &&
            (t.type === "undefined" || t.type === "void")
          )
      );

      if (present.length === 1) {
        return { ...schema, ...irToJsonSchema(present[0]!, draft) };
      }

      if (present.length > 0 && present.every((t) => t.kind === "literal")) {
        schema.enum = present.map((t) => (t as { value: unknown }).value);
      } else if (ir.discriminator) {
        schema.oneOf = present.map((t) => irToJsonSchema(t, draft));
        schema.discriminator = { propertyName: ir.discriminator.propertyName };
      } else {
        schema.anyOf = present.map((t) => irToJsonSchema(t, draft));
      }
      break;
    }

    case "intersection": {
      schema.allOf = ir.types.map((t) => irToJsonSchema(t, draft));
      break;
    }

    case "record": {
      schema.type = "object";
      schema.additionalProperties = irToJsonSchema(ir.valueType, draft);
      break;
    }

    case "ref": {
      schema.$ref = `#/$defs/${ir.targetId}`;
      break;
    }
  }

  return schema;
}

export function generateSchemaCode(ir: TypeIR): string {
  const schema2020 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...irToJsonSchema(ir, "draft-2020-12"),
  };

  const schema07 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...irToJsonSchema(ir, "draft-07"),
  };

  return [
    `export const schema_draft2020 = ${JSON.stringify(schema2020, null, 2)};`,
    `export const schema_draft07 = ${JSON.stringify(schema07, null, 2)};`,
  ].join("\n");
}
