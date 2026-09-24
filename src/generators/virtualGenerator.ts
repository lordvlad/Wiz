import { isGrpcMethod, type ServiceIR } from "../ir/service.ts";
import type { TypeIR } from "../types.ts";
import { generateArrowCode, generateArrowSchemaCode } from "./arrow.ts";
import { generateAsyncApiSchemaCode, type AsyncApiVersion } from "./asyncapi.ts";
import { generateAvroCode, generateAvroSchemaCode } from "./avro.ts";
import { generateCborCode } from "./cbor.ts";
import { generateErlangTextCode, generateErlangBinaryCode } from "./erlang.ts";
import type { Generator } from "./generator.ts";
import { generateJsonCode } from "./json.ts";
import { generateKeysCode } from "./keys.ts";
import { generateMcpSchemaCode } from "./mcp.ts";
import { generateOpenApiSchemaCode } from "./openapi.ts";
import { generateOpenRpcSchemaCode } from "./openrpc.ts";
import { generateGrpcSchemaCode, generateProtobufCode, generateProtobufSchemaCode } from "./protobuf.ts";
import { generateQueryParserCode } from "./query.ts";
import { generateSchemaCode, generateJsonSchemasCode } from "./schema.ts";
import { generateValidatorCode } from "./validator.ts";
import { generateZodSchemaCode } from "./zod.ts";

export interface VirtualModuleOptions {
    openApiTypes?: Array<{ name: string; ir: TypeIR }>;
    openRpcTypes?: Array<{ name: string; ir: TypeIR }>;
    asyncApiTypes?: Array<{ name: string; ir: TypeIR }>;
    mcpTypes?: Array<{ name: string; ir: TypeIR }>;
    grpcTypes?: Array<{ name: string; ir: TypeIR }>;
    openApiVersion?: "3.0" | "3.1";
    asyncApiVersion?: AsyncApiVersion;
    service?: ServiceIR;
    protobufSchemaTypes?: Array<{ name: string; ir: TypeIR }>;
    avroSchemaTypes?: Array<{ name: string; ir: TypeIR }>;
    arrowSchemaTypes?: Array<{ name: string; ir: TypeIR }>;
    zod?: boolean;
    jsonSchemasTypes?: Array<{ name: string; ir: TypeIR }>;
    /**
     * Whether to emit the Arrow codec.
     *
     * Unlike the other back ends this is opt-in, because generating it needs
     * `apache-arrow` at build time to produce the schema message. A project that
     * never mentions Arrow should never be asked for that dependency.
     */
    arrow?: boolean;
    /**
     * Export names to emit, when only some are wanted.
     *
     * A module serving a bundler carries every generator, because callsites in
     * other files share it by type key and a bundler drops what it does not use.
     * `wiz eject` inlines this code for a person to read, where several hundred
     * lines of unreachable codec is just noise.
     */
    only?: readonly string[];
}

/** Which exports each generated section provides. */
const SECTION_EXPORTS = {
    keys: ["keys", "requiredKeys", "optionalKeys", "deepKeys"],
    schema: ["jsonSchema_draft2020", "jsonSchema_draft07", "jsonSchemas_draft2020", "jsonSchemas_draft07"],
    validator: ["validate", "is", "assert"],
    queryParser: ["parseQuery"],
    openapi: ["openapiSchema"],
    protobuf: ["encodeProto", "decodeProto"],
    protobufSchema: ["protobufSchema"],
    avro: ["encodeAvro", "decodeAvro"],
    avroSchema: ["avroSchema"],
    arrow: ["encodeArrow", "decodeArrow"],
    arrowSchema: ["arrowSchema"],
    zod: ["zodSchema"],
    json: ["encodeJson", "decodeJson"],
    openrpc: ["openRPCSchema"],
    erlangText: ["encodeErlangText", "decodeErlangText"],
    erlangBinary: ["encodeErlangBinary", "decodeErlangBinary"],
    cbor: ["encodeCbor", "decodeCbor"],
    asyncapi: ["asyncapiSchema"],
    mcp: ["mcpSchema"],
    grpcSchema: ["grpcSchema"],
} as const;

export function generateVirtualModuleCode(ir: TypeIR, options?: VirtualModuleOptions): string {
    const wanted = options?.only;
    const include = (section: keyof typeof SECTION_EXPORTS): boolean =>
        wanted === undefined ||
        SECTION_EXPORTS[section].some((name) => wanted.includes(name)) ||
        (section === "validator" && wanted.includes("parseQuery"));

    const parts = [`// Auto-generated virtual module by wizPlugin`];

    if (include("keys")) {
        parts.push(generateKeysCode(ir));
    }
    if (include("schema")) {
        parts.push(generateSchemaCode(ir));
    }
    if (options?.jsonSchemasTypes?.length && include("schema")) {
        parts.push(generateJsonSchemasCode(options.jsonSchemasTypes));
    }
    if (include("validator")) {
        parts.push(generateValidatorCode(ir));
    }
    if (include("queryParser")) {
        parts.push(generateQueryParserCode(ir));
    }
    if (include("protobuf")) {
        parts.push(generateProtobufCode(ir));
    }
    if (include("avro")) {
        parts.push(generateAvroCode(ir));
    }
    if (include("json")) {
        parts.push(generateJsonCode(ir));
    }
    if (include("erlangText")) {
        parts.push(generateErlangTextCode(ir));
    }
    if (include("erlangBinary")) {
        parts.push(generateErlangBinaryCode(ir));
    }
    if (include("cbor")) {
        parts.push(generateCborCode(ir));
    }

    // An empty `openApiTypes` array is still a request for an OpenAPI document:
    // `openapiSchema<[]>(base, [...ops])` carries all its content in methods.
    if ((options?.openApiTypes || options?.service) && include("openapi")) {
        parts.push(
            generateOpenApiSchemaCode(options.openApiTypes ?? [], options.openApiVersion ?? "3.1", options.service),
        );
    }
    if ((options?.openRpcTypes || options?.service) && include("openrpc")) {
        parts.push(generateOpenRpcSchemaCode(options.openRpcTypes ?? [], options.service));
    }
    if ((options?.asyncApiTypes || options?.service) && include("asyncapi")) {
        parts.push(
            generateAsyncApiSchemaCode(options.asyncApiTypes ?? [], options.asyncApiVersion ?? "3.0", options.service),
        );
    }
    if ((options?.mcpTypes || options?.service) && include("mcp")) {
        parts.push(generateMcpSchemaCode(options.mcpTypes ?? [], options.service));
    }
    if ((options?.grpcTypes || options?.service?.methods.some(isGrpcMethod)) && include("grpcSchema")) {
        parts.push(generateGrpcSchemaCode(options.grpcTypes ?? [], options.service));
    }

    if (options?.protobufSchemaTypes?.length && include("protobufSchema")) {
        parts.push(generateProtobufSchemaCode(options.protobufSchemaTypes));
    }

    if (options?.avroSchemaTypes?.length && include("avroSchema")) {
        parts.push(generateAvroSchemaCode(options.avroSchemaTypes));
    }

    if (options?.arrow && include("arrow")) {
        parts.push(generateArrowCode(ir));
    }

    if (options?.arrowSchemaTypes?.length && include("arrowSchema")) {
        parts.push(generateArrowSchemaCode(options.arrowSchemaTypes));
    }
    if (options?.zod && include("zod")) {
        parts.push(generateZodSchemaCode(ir));
    }
    return parts.join("\n\n");
}

/**
 * The entry file every virtual module map provides.
 *
 * A generator's contract is a file map, but the plugin's rewriter has to name
 * one file of it in an import specifier, so the entry is a convention instead
 * of a manifest: whatever else a virtual generator emits, `index.js` is the
 * file whose exports the rewritten callsites bind.
 */
export const VIRTUAL_ENTRY = "index.js";

/**
 * The plugin's emitter, addressed through the pluggable generator interface.
 *
 * Only `type` is implemented: a virtual module is what one type compiles to,
 * and the service and document roots are somebody else's output. The map's one
 * file is the entry; the mount directory around it - `wiz-virtual/<key>/` - is
 * the plugin's to add, since outside the plugin there is no registry to key.
 */
export const virtualGenerator: Generator<VirtualModuleOptions> = {
    name: "wiz virtual module",
    type(ir, context) {
        return { [VIRTUAL_ENTRY]: generateVirtualModuleCode(ir, context.options) };
    },
};

export default virtualGenerator;
