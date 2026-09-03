import type { ServiceIR } from "../ir/service.ts";
import type { TypeIR } from "../types.ts";
import { irToJsonSchema } from "./schema.ts";

export type AsyncApiVersion = "2.6" | "3.0";

/**
 * Converts a TypeIR tree into an AsyncAPI Schema Object.
 */
export function irToAsyncApiSchema(
  ir: TypeIR,
  draft: "draft-2020-12" | "draft-07" = "draft-2020-12"
): Record<string, unknown> {
  return irToJsonSchema(ir, draft);
}

/**
 * Generates Virtual Module code for `asyncapiSchema`.
 */
export function generateAsyncApiSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>,
  version: AsyncApiVersion = "3.0",
  service?: ServiceIR
): string {
  const schemas: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};

  for (const { name, ir } of types) {
    const schema = irToAsyncApiSchema(ir);
    schemas[name] = schema;
    messages[name] = {
      name,
      title: name,
      payload: { $ref: `#/components/schemas/${name}` },
    };
  }

  const document: Record<string, unknown> = {};

  if (version === "3.0") {
    document.asyncapi = "3.0.0";
    document.info = {
      title: service?.name ?? "AsyncAPI Service",
      version: service?.version ?? "1.0.0",
      description: service?.description,
    };

    const channels: Record<string, unknown> = {};
    const operations: Record<string, unknown> = {};

    if (service?.methods) {
      service.methods.forEach((method, index) => {
        const addr = method.address.protocol === "asyncapi" ? method.address.channel : `channel_${index}`;
        const action = method.address.protocol === "asyncapi" ? method.address.action : "send";
        const opId = method.operationId ?? `${action}_${index}`;
        const chanKey = addr.replace(/[^a-zA-Z0-9_]/g, "_");

        channels[chanKey] = {
          address: addr,
          messages: method.request?.body?.[0]?.content?.name
            ? {
                [method.request.body[0].content.name]: {
                  $ref: `#/components/messages/${method.request.body[0].content.name}`,
                },
              }
            : {},
        };

        operations[opId] = {
          action,
          channel: { $ref: `#/channels/${chanKey}` },
          summary: method.summary,
          description: method.description,
        };
      });
    }

    document.channels = channels;
    document.operations = operations;
    document.components = {
      messages,
      schemas,
    };
  } else {
    // 2.6.0
    document.asyncapi = "2.6.0";
    document.info = {
      title: service?.name ?? "AsyncAPI Service",
      version: service?.version ?? "1.0.0",
      description: service?.description,
    };

    const channels: Record<string, unknown> = {};

    if (service?.methods) {
      service.methods.forEach((method, index) => {
        const addr = method.address.protocol === "asyncapi" ? method.address.channel : `channel_${index}`;
        const action = method.address.protocol === "asyncapi" && method.address.action === "send" ? "publish" : "subscribe";
        const opId = method.operationId ?? `${action}_${index}`;

        const msgRef = method.request?.body?.[0]?.content?.name
          ? { $ref: `#/components/messages/${method.request.body[0].content.name}` }
          : undefined;

        channels[addr] = {
          [action]: {
            operationId: opId,
            summary: method.summary,
            description: method.description,
            message: msgRef,
          },
        };
      });
    }

    document.channels = channels;
    document.components = {
      messages,
      schemas,
    };
  }

  const jsonText = JSON.stringify(document, null, 2);

  return [
    `function buildAsyncApiDocument(baseSchema = {}) {`,
    `  const generated = ${jsonText};`,
    `  return {`,
    `    ...generated,`,
    `    ...baseSchema,`,
    `    info: { ...generated.info, ...(baseSchema.info || {}) },`,
    `    components: {`,
    `      ...generated.components,`,
    `      ...(baseSchema.components || {}),`,
    `      schemas: { ...generated.components.schemas, ...((baseSchema.components && baseSchema.components.schemas) || {}) },`,
    `      messages: { ...generated.components.messages, ...((baseSchema.components && baseSchema.components.messages) || {}) },`,
    `    },`,
    `  };`,
    `}`,
    ``,
    `export function asyncapiSchema(baseSchema = {}) {`,
    `  return buildAsyncApiDocument(baseSchema);`,
    `}`,
  ].join("\n");
}
