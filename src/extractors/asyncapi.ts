import { emptyApiComponents, type ApiDiagnostic, type ApiIR } from '../ir/api.ts';
import type { ParameterIR, ServiceIR, ServiceMethodIR } from '../ir/service.ts';
import type { TypeIR } from '../ir/types.ts';
import { jsonSchemaToIR as schemaToIR } from './jsonSchema.ts';
import { parseApiDocument, type ExtractApiOptions } from './openapi.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function token(part: string): string {
  return part.replace(/~/g, '~0').replace(/\//g, '~1');
}

interface Ctx {
  version: '2.6' | '3.0';
  document: Record<string, unknown>;
  diagnostics: ApiDiagnostic[];
  strict: boolean;
  ids: number;
}

function detectVersion(document: Record<string, unknown>): '2.6' | '3.0' {
  const declared = document.asyncapi;
  if (typeof declared === 'string') {
    if (declared.startsWith('2.')) {
      return '2.6';
    }
    if (declared.startsWith('3.')) {
      return '3.0';
    }
  }
  return '3.0';
}

export function extractAsyncApiIR(text: string, options: ExtractApiOptions = {}): ApiIR {
  const parsed = parseApiDocument(text, options.format);
  if (!isObject(parsed)) {
    throw new Error('[wiz] AsyncAPI document must be an object');
  }

  const ctx: Ctx = {
    version: detectVersion(parsed),
    document: parsed,
    diagnostics: [],
    strict: options.strict === true,
    ids: 0,
  };

  const infoObj = isObject(parsed.info) ? parsed.info : {};
  const serviceName = typeof infoObj.title === 'string' ? infoObj.title : undefined;
  const serviceVer = typeof infoObj.version === 'string' ? infoObj.version : undefined;
  const serviceDesc = typeof infoObj.description === 'string' ? infoObj.description : undefined;

  const typesMap = new Map<string, TypeIR>();
  const componentsObj = isObject(parsed.components) ? parsed.components : {};
  const schemasObj = isObject(componentsObj.schemas) ? componentsObj.schemas : {};

  for (const [schemaName, schemaRaw] of Object.entries(schemasObj)) {
    const ir = schemaToIR(schemaRaw, ctx, `#/components/schemas/${token(schemaName)}`);
    // Every component is a declaration a client can name; only a `$ref`
    // already carries the name of what it points at.
    if (ir.kind !== 'ref') {
      ir.name = schemaName;
    }
    typesMap.set(schemaName, ir);
  }

  // A message is addressed by its own name, so it is registered too - but a
  // payload that is only `$ref: #/components/schemas/X` declares nothing: it
  // resolves to the schema, which is already here. Naming that ref after the
  // message is what used to emit `export type X = X`.
  const messagesObj = isObject(componentsObj.messages) ? componentsObj.messages : {};
  for (const [msgName, msgRaw] of Object.entries(messagesObj)) {
    if (!isObject(msgRaw) || !msgRaw.payload) {
      continue;
    }
    const ir = schemaToIR(msgRaw.payload, ctx, `#/components/messages/${token(msgName)}/payload`);
    if (ir.kind === 'ref') {
      const target = typesMap.get(ir.targetId);
      if (target) {
        if (msgName !== ir.targetId) {
          typesMap.set(msgName, target);
        }
        continue;
      }
    }
    ir.name = msgName;
    typesMap.set(msgName, ir);
  }

  const methods: ServiceMethodIR[] = [];

  if (ctx.version === '3.0') {
    const operationsObj = isObject(parsed.operations) ? parsed.operations : {};
    const channelsObj = isObject(parsed.channels) ? parsed.channels : {};

    for (const [opId, opRaw] of Object.entries(operationsObj)) {
      if (!isObject(opRaw)) {
        continue;
      }
      const action = opRaw.action === 'send' ? 'send' : 'receive';
      let channelAddr = opId;

      let chanObj: Record<string, unknown> | undefined;
      if (isObject(opRaw.channel)) {
        if (typeof opRaw.channel.$ref === 'string') {
          const channelKey = opRaw.channel.$ref.split('/').pop();
          if (channelKey && isObject(channelsObj[channelKey])) {
            chanObj = channelsObj[channelKey] as Record<string, unknown>;
            if (typeof chanObj.address === 'string') {
              channelAddr = chanObj.address;
            }
          }
        } else if (typeof opRaw.channel.address === 'string') {
          chanObj = opRaw.channel;
          channelAddr = opRaw.channel.address;
        }
      }

      let payloadType: TypeIR | undefined;
      if (Array.isArray(opRaw.messages)) {
        const firstMsg = opRaw.messages[0];
        if (isObject(firstMsg) && typeof firstMsg.$ref === 'string') {
          const msgKey = firstMsg.$ref.split('/').pop();
          if (msgKey) {
            payloadType = typesMap.get(msgKey);
          }
        }
      }
      if (!payloadType && chanObj && isObject(chanObj.messages)) {
        const firstMsg = Object.values(chanObj.messages)[0];
        if (isObject(firstMsg) && typeof firstMsg.$ref === 'string') {
          const msgKey = firstMsg.$ref.split('/').pop();
          if (msgKey) {
            payloadType = typesMap.get(msgKey);
          }
        }
      }

      methods.push({
        kind: 'serviceMethod',
        protocol: 'asyncapi',
        operationId: opId,
        summary: typeof opRaw.summary === 'string' ? opRaw.summary : undefined,
        description: typeof opRaw.description === 'string' ? opRaw.description : undefined,
        address: {
          protocol: 'asyncapi',
          channel: channelAddr,
          action,
        },
        request: {
          protocol: 'asyncapi',
          body: payloadType ? [{ mimetype: 'application/json', content: payloadType }] : undefined,
        },
        responses: [
          {
            protocol: 'asyncapi',
            body: payloadType
              ? [{ mimetype: 'application/json', content: payloadType }]
              : undefined,
          },
        ],
      });
    }
  } else {
    // AsyncAPI 2.6
    const channelsObj = isObject(parsed.channels) ? parsed.channels : {};
    for (const [channelPath, chanRaw] of Object.entries(channelsObj)) {
      if (!isObject(chanRaw)) {
        continue;
      }

      for (const action of ['publish', 'subscribe'] as const) {
        const opRaw = chanRaw[action];
        if (!isObject(opRaw)) {
          continue;
        }

        const act = action === 'publish' ? 'send' : 'receive';
        let payloadType: TypeIR | undefined;
        if (isObject(opRaw.message)) {
          if (typeof opRaw.message.$ref === 'string') {
            const msgKey = opRaw.message.$ref.split('/').pop();
            if (msgKey) {
              payloadType = typesMap.get(msgKey);
            }
          } else if (opRaw.message.payload) {
            payloadType = schemaToIR(
              opRaw.message.payload,
              ctx,
              `#/channels/${token(channelPath)}/${action}/message/payload`
            );
          }
        }

        methods.push({
          kind: 'serviceMethod',
          protocol: 'asyncapi',
          operationId: typeof opRaw.operationId === 'string' ? opRaw.operationId : undefined,
          summary: typeof opRaw.summary === 'string' ? opRaw.summary : undefined,
          description: typeof opRaw.description === 'string' ? opRaw.description : undefined,
          address: {
            protocol: 'asyncapi',
            channel: channelPath,
            action: act,
          },
          request: {
            protocol: 'asyncapi',
            body: payloadType
              ? [{ mimetype: 'application/json', content: payloadType }]
              : undefined,
          },
          responses: [
            {
              protocol: 'asyncapi',
              body: payloadType
                ? [{ mimetype: 'application/json', content: payloadType }]
                : undefined,
            },
          ],
        });
      }
    }
  }

  const service: ServiceIR = {
    kind: 'service',
    name: serviceName,
    version: serviceVer,
    description: serviceDesc,
    methods,
  };

  return {
    kind: 'api',
    version: `asyncapi-${ctx.version}`,
    types: typesMap,
    components: emptyApiComponents(),
    service,
    diagnostics: ctx.diagnostics,
  };
}
