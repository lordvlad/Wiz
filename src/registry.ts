import {
  generate,
  type GeneratedFiles,
} from "./generators/generator.ts";
import {
  virtualGenerator,
  type VirtualModuleOptions,
} from "./generators/virtualGenerator.ts";
import { normalizeServiceMethod } from "./ir/service.ts";
import { fnv1a, normalizeTypeIR, type TypeIR } from "./types.ts";

export interface RegisteredType {
  /**
   * The virtual module's identity: the type key plus everything else that
   * changes the emitted code. Callers name their import after it.
   */
  key: string;
  ir: TypeIR;
  /** The generated file map, mounted by the plugin under `wiz-virtual/<key>/`. */
  files: GeneratedFiles;
  /** Kept so a caller wanting a different subset can regenerate faithfully. */
  options?: VirtualModuleOptions;
}

const TypeRegistry = new Map<string, RegisteredType>();

function namedTypesKey(
  types: Array<{ name: string; ir: TypeIR }> | undefined
): unknown {
  // Names are part of a schema payload's identity: they become
  // `components.schemas` keys, `$ref` targets and message names, so two
  // payloads differing only in a nested name are two modules.
  return types?.map((t) => [t.name, normalizeTypeIR(t.ir, true)]) ?? null;
}

/**
 * The part of the module's identity that the *type* key cannot express.
 *
 * A generator payload changes the emitted code, so it has to change the key:
 * `openapiSchema<[User], "3.0">()` and `openapiSchema<[User], "3.1">()` are
 * the same type and must still be two modules. Without this they collided,
 * and whichever transformed last silently redefined the other.
 */
function payloadKey(options: VirtualModuleOptions): string {
  return fnv1a(
    JSON.stringify({
      o: namedTypesKey(options.openApiTypes),
      v: options.openApiVersion ?? null,
      s: options.service?.methods.map(normalizeServiceMethod) ?? null,
      p: namedTypesKey(options.protobufSchemaTypes),
      a: namedTypesKey(options.avroSchemaTypes),
      w: namedTypesKey(options.arrowSchemaTypes),
      g: namedTypesKey(options.grpcTypes),
      r: options.arrow ?? false,
      z: options.zod ?? false,
      // `only` is deliberately absent: it is applied when the module is
      // emitted (`generateVirtualModuleCode(..., { only })`), never at
      // registration, so it cannot distinguish two registered modules.
    })
  );
}

/**
 * Registers the virtual module for one type, returning its identity.
 *
 * Content-addressed: an entry is only ever written once, because anything that
 * would change the generated code is already in the key.
 */
export function registerType(
  typeHash: string,
  ir: TypeIR,
  options?: VirtualModuleOptions
): RegisteredType {
  const key = options ? `${typeHash}_${payloadKey(options)}` : typeHash;

  const existing = TypeRegistry.get(key);
  if (existing) return existing;

  const registered: RegisteredType = {
    key,
    ir,
    files: generate(ir, virtualGenerator, options ?? {}),
    options,
  };
  TypeRegistry.set(key, registered);
  return registered;
}

export function getTypeModuleFiles(key: string): GeneratedFiles | undefined {
  return TypeRegistry.get(key)?.files;
}

/** The whole entry, for a caller that needs to regenerate a subset. */
export function getRegisteredType(key: string): RegisteredType | undefined {
  return TypeRegistry.get(key);
}

export function clearTypeRegistry(): void {
  TypeRegistry.clear();
}
