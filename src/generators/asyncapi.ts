import { isAsyncApiMethod, type ServiceIR } from '../ir/service.ts';
import type { TypeIR } from '../types.ts';
import { assertValidSpecDocumentSync } from '../validators/jsonSchema.ts';
import { irToJsonSchema } from './schema.ts';

export type AsyncApiVersion = '2.6' | '3.0';

/**
 * Converts a TypeIR tree into an AsyncAPI Schema Object.
 */
export function irToAsyncApiSchema(
  ir: TypeIR,
  draft: 'draft-2020-12' | 'draft-07' = 'draft-2020-12'
): Record<string, unknown> {
  return irToJsonSchema(ir, draft);
}

/**
 * Generates Virtual Module code for `asyncapiSchema`.
 */
export function generateAsyncApiSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>,
  version: AsyncApiVersion = '3.0',
  service?: ServiceIR
): string {
  const schemas: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};

  const register = (name: string, ir: TypeIR): void => {
    if (schemas[name]) {
      return;
    }
    schemas[name] = irToAsyncApiSchema(ir);
    messages[name] = {
      name,
      title: name,
      payload: { $ref: `#/components/schemas/${name}` },
    };
  };

  for (const { name, ir } of types) {
    register(name, ir);
  }

  // A channel refs `#/components/messages/<payload>`, so a payload that only a
  // harvested method mentions has to be registered too: otherwise the document
  // carries a ref to nothing, which is what `asyncapiSchema<[Events]>()` used
  // to emit when the message type was not also passed by hand.
  for (const method of service?.methods ?? []) {
    if (!isAsyncApiMethod(method)) {
      continue;
    }
    const payload = method.request.body?.[0]?.content;
    if (payload?.name) {
      register(payload.name, payload);
    }
  }

  const document: Record<string, unknown> = {};

  if (version === '3.0') {
    document.asyncapi = '3.0.0';
    document.info = {
      title: service?.name ?? 'AsyncAPI Service',
      version: service?.version ?? '1.0.0',
      description: service?.description,
    };

    const channels: Record<string, unknown> = {};
    const operations: Record<string, unknown> = {};

    if (service?.methods) {
      service.methods.forEach((method, index) => {
        if (!isAsyncApiMethod(method)) {
          return;
        }
        const pkg = method.address.package ?? service.package;
        const svc = method.address.service ?? service.name;
        const rawChan = method.address.channel || `channel_${index}`;
        const fullChan =
          pkg && svc ? `${pkg}.${svc}.${rawChan}` : svc ? `${svc}.${rawChan}` : rawChan;
        const action = method.address.action;
        const opId = method.operationId ?? `${action}_${index}`;
        const chanKey = fullChan.replace(/[^a-zA-Z0-9_.]/g, '_');
        const messageName = method.request.body?.[0]?.content.name;

        channels[chanKey] = {
          address: rawChan,
          ...(pkg ? { 'x-package': pkg } : {}),
          ...(svc ? { 'x-service': svc } : {}),
          messages: messageName
            ? {
                [messageName]: {
                  $ref: `#/components/messages/${messageName}`,
                },
              }
            : {},
        };

        operations[opId] = {
          action,
          channel: { $ref: `#/channels/${chanKey}` },
          summary: method.summary,
          description: method.description,
          ...(pkg ? { 'x-package': pkg } : {}),
          ...(svc ? { 'x-service': svc } : {}),
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
    document.asyncapi = '2.6.0';
    document.info = {
      title: service?.name ?? 'AsyncAPI Service',
      version: service?.version ?? '1.0.0',
      description: service?.description,
    };

    const channels: Record<string, unknown> = {};

    if (service?.methods) {
      service.methods.forEach((method, index) => {
        if (!isAsyncApiMethod(method)) {
          return;
        }
        const pkg = method.address.package ?? service.package;
        const svc = method.address.service ?? service.name;
        const rawChan = method.address.channel || `channel_${index}`;
        const fullChan =
          pkg && svc ? `${pkg}.${svc}.${rawChan}` : svc ? `${svc}.${rawChan}` : rawChan;
        const action = method.address.action === 'send' ? 'publish' : 'subscribe';
        const opId = method.operationId ?? `${action}_${index}`;
        const messageName = method.request.body?.[0]?.content.name;

        const msgRef = messageName ? { $ref: `#/components/messages/${messageName}` } : undefined;

        channels[fullChan] = {
          [action]: {
            operationId: opId,
            summary: method.summary,
            description: method.description,
            message: msgRef,
            ...(pkg ? { 'x-package': pkg } : {}),
            ...(svc ? { 'x-service': svc } : {}),
          },
          ...(pkg ? { 'x-package': pkg } : {}),
          ...(svc ? { 'x-service': svc } : {}),
        };
      });
    }

    document.channels = channels;
    document.components = {
      messages,
      schemas,
    };
  }
  assertValidSpecDocumentSync(document, 'AsyncAPI');

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
  ].join('\n');
}
