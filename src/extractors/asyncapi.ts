import {
  emptyApiComponents,
  type ApiDiagnostic,
  type ApiIR,
} from "../ir/api.ts";
import type { TypeIR } from "../ir/types.ts";
import type {
  ParameterIR,
  ServiceIR,
  ServiceMethodIR,
} from "../ir/service.ts";
import { parseApiDocument, type ExtractApiOptions } from "./openapi.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(part: string): string {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface Ctx {
  version: "2.6" | "3.0";
  document: Record<string, unknown>;
  diagnostics: ApiDiagnostic[];
  strict: boolean;
  ids: number;
}

function nextId(ctx: Ctx): string {
  return `o_${++ctx.ids}`;
}

const SCHEMAS_REF = "#/components/schemas/";

function schemaToIR(raw: unknown, ctx: Ctx, pointer: string): TypeIR {
  if (raw === undefined || raw === true) {
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }
  if (raw === false) {
    return { id: nextId(ctx), kind: "primitive", type: "never" };
  }
  if (!isObject(raw)) {
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }

  if (typeof raw.$ref === "string") {
    const ref = raw.$ref;
    if (ref.startsWith(SCHEMAS_REF) && ref.length > SCHEMAS_REF.length) {
      const name = ref.slice(SCHEMAS_REF.length);
      return { id: nextId(ctx), kind: "ref", targetId: name, name };
    }
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }

  const declared = raw.type;
  const typeName = typeof declared === "string" ? declared : undefined;

  if (typeName === "string") {
    if (Array.isArray(raw.enum)) {
      return {
        id: nextId(ctx),
        kind: "enum",
        members: raw.enum.map((v) => ({ name: String(v), value: String(v) })),
      };
    }
    return { id: nextId(ctx), kind: "primitive", type: "string" };
  }
  if (typeName === "integer" || typeName === "number") {
    return { id: nextId(ctx), kind: "primitive", type: "number" };
  }
  if (typeName === "boolean") {
    return { id: nextId(ctx), kind: "primitive", type: "boolean" };
  }
  if (typeName === "null") {
    return { id: nextId(ctx), kind: "primitive", type: "null" };
  }

  if (typeName === "array" || Array.isArray(raw.items)) {
    const itemSchema = isObject(raw.items) ? raw.items : {};
    return {
      id: nextId(ctx),
      kind: "array",
      element: schemaToIR(itemSchema, ctx, `${pointer}/items`),
    };
  }

  if (typeName === "object" || isObject(raw.properties)) {
    const propsObj = isObject(raw.properties) ? raw.properties : {};
    const requiredList = Array.isArray(raw.required)
      ? raw.required.filter((r): r is string => typeof r === "string")
      : [];

    const properties = Object.entries(propsObj).map(([propName, propRaw]) => {
      const isReq = requiredList.includes(propName);
      const propType = schemaToIR(propRaw, ctx, `${pointer}/properties/${token(propName)}`);
      return {
        name: propName,
        type: propType,
        optional: !isReq,
        readonly: isObject(propRaw) && propRaw.readOnly === true,
        description: isObject(propRaw) && typeof propRaw.description === "string" ? propRaw.description : undefined,
      };
    });

    return {
      id: nextId(ctx),
      kind: "object",
      properties,
    };
  }

  if (Array.isArray(raw.oneOf) || Array.isArray(raw.anyOf)) {
    const membersRaw = (raw.oneOf || raw.anyOf) as unknown[];
    const types = membersRaw.map((m, idx) =>
      schemaToIR(m, ctx, `${pointer}/oneOf/${idx}`)
    );
    return { id: nextId(ctx), kind: "union", types };
  }

  return { id: nextId(ctx), kind: "primitive", type: "unknown" };
}

function detectVersion(document: Record<string, unknown>): "2.6" | "3.0" {
  const declared = document.asyncapi;
  if (typeof declared === "string") {
    if (declared.startsWith("2.")) return "2.6";
    if (declared.startsWith("3.")) return "3.0";
  }
  return "3.0";
}

export function extractAsyncApiIR(
  text: string,
  options: ExtractApiOptions = {}
): ApiIR {
  const parsed = parseApiDocument(text, options.format);
  if (!isObject(parsed)) {
    throw new Error("[wiz] AsyncAPI document must be an object");
  }

  const ctx: Ctx = {
    version: detectVersion(parsed),
    document: parsed,
    diagnostics: [],
    strict: options.strict === true,
    ids: 0,
  };

  const infoObj = isObject(parsed.info) ? parsed.info : {};
  const serviceName = typeof infoObj.title === "string" ? infoObj.title : undefined;
  const serviceVer = typeof infoObj.version === "string" ? infoObj.version : undefined;
  const serviceDesc = typeof infoObj.description === "string" ? infoObj.description : undefined;

  const typesMap = new Map<string, TypeIR>();
  const componentsObj = isObject(parsed.components) ? parsed.components : {};
  const schemasObj = isObject(componentsObj.schemas) ? componentsObj.schemas : {};

  for (const [schemaName, schemaRaw] of Object.entries(schemasObj)) {
    const ir = schemaToIR(schemaRaw, ctx, `#/components/schemas/${token(schemaName)}`);
    if (ir.kind === "object" || ir.kind === "enum") {
      ir.name = schemaName;
    }
    typesMap.set(schemaName, ir);
  }

  // Also harvest messages into typesMap
  const messagesObj = isObject(componentsObj.messages) ? componentsObj.messages : {};
  for (const [msgName, msgRaw] of Object.entries(messagesObj)) {
    if (isObject(msgRaw) && msgRaw.payload) {
      const ir = schemaToIR(msgRaw.payload, ctx, `#/components/messages/${token(msgName)}/payload`);
      ir.name = msgName;
      typesMap.set(msgName, ir);
    }
  }

  const methods: ServiceMethodIR[] = [];

  if (ctx.version === "3.0") {
    const operationsObj = isObject(parsed.operations) ? parsed.operations : {};
    const channelsObj = isObject(parsed.channels) ? parsed.channels : {};

    for (const [opId, opRaw] of Object.entries(operationsObj)) {
      if (!isObject(opRaw)) continue;
      const action = opRaw.action === "send" ? "send" : "receive";
      let channelAddr = opId;

      let chanObj: Record<string, unknown> | undefined;
      if (isObject(opRaw.channel)) {
        if (typeof opRaw.channel.$ref === "string") {
          const channelKey = opRaw.channel.$ref.split("/").pop();
          if (channelKey && isObject(channelsObj[channelKey])) {
            chanObj = channelsObj[channelKey] as Record<string, unknown>;
            if (typeof chanObj.address === "string") channelAddr = chanObj.address;
          }
        } else if (typeof opRaw.channel.address === "string") {
          chanObj = opRaw.channel;
          channelAddr = opRaw.channel.address;
        }
      }

      let payloadType: TypeIR | undefined;
      if (Array.isArray(opRaw.messages)) {
        const firstMsg = opRaw.messages[0];
        if (isObject(firstMsg) && typeof firstMsg.$ref === "string") {
          const msgKey = firstMsg.$ref.split("/").pop();
          if (msgKey) payloadType = typesMap.get(msgKey);
        }
      }
      if (!payloadType && chanObj && isObject(chanObj.messages)) {
        const firstMsg = Object.values(chanObj.messages)[0];
        if (isObject(firstMsg) && typeof firstMsg.$ref === "string") {
          const msgKey = firstMsg.$ref.split("/").pop();
          if (msgKey) payloadType = typesMap.get(msgKey);
        }
      }

      methods.push({
        kind: "serviceMethod",
        protocol: "asyncapi",
        operationId: opId,
        summary: typeof opRaw.summary === "string" ? opRaw.summary : undefined,
        description: typeof opRaw.description === "string" ? opRaw.description : undefined,
        address: {
          protocol: "asyncapi",
          channel: channelAddr,
          action,
        },
        request: {
          protocol: "asyncapi",
          body: payloadType ? [{ mimetype: "application/json", content: payloadType }] : undefined,
        },
        responses: [
          {
            protocol: "asyncapi",
            body: payloadType ? [{ mimetype: "application/json", content: payloadType }] : undefined,
          },
        ],
      });
    }
  } else {
    // AsyncAPI 2.6
    const channelsObj = isObject(parsed.channels) ? parsed.channels : {};
    for (const [channelPath, chanRaw] of Object.entries(channelsObj)) {
      if (!isObject(chanRaw)) continue;

      for (const action of ["publish", "subscribe"] as const) {
        const opRaw = chanRaw[action];
        if (!isObject(opRaw)) continue;

        const act = action === "publish" ? "send" : "receive";
        let payloadType: TypeIR | undefined;
        if (isObject(opRaw.message)) {
          if (typeof opRaw.message.$ref === "string") {
            const msgKey = opRaw.message.$ref.split("/").pop();
            if (msgKey) payloadType = typesMap.get(msgKey);
          } else if (opRaw.message.payload) {
            payloadType = schemaToIR(opRaw.message.payload, ctx, `#/channels/${token(channelPath)}/${action}/message/payload`);
          }
        }

        methods.push({
          kind: "serviceMethod",
          protocol: "asyncapi",
          operationId: typeof opRaw.operationId === "string" ? opRaw.operationId : undefined,
          summary: typeof opRaw.summary === "string" ? opRaw.summary : undefined,
          description: typeof opRaw.description === "string" ? opRaw.description : undefined,
          address: {
            protocol: "asyncapi",
            channel: channelPath,
            action: act,
          },
          request: {
            protocol: "asyncapi",
            body: payloadType ? [{ mimetype: "application/json", content: payloadType }] : undefined,
          },
          responses: [
            {
              protocol: "asyncapi",
              body: payloadType ? [{ mimetype: "application/json", content: payloadType }] : undefined,
            },
          ],
        });
      }
    }
  }

  const service: ServiceIR = {
    kind: "service",
    name: serviceName,
    version: serviceVer,
    description: serviceDesc,
    methods,
  };

  return {
    kind: "api",
    version: `asyncapi-${ctx.version}`,
    types: typesMap,
    components: emptyApiComponents(),
    service,
    diagnostics: ctx.diagnostics,
  };
}
