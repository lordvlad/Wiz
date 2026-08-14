import {
  generateVirtualModuleCode,
  type VirtualModuleOptions,
} from "./generators/virtualGenerator.ts";
import type { TypeIR } from "./types.ts";

export interface RegisteredType {
  ir: TypeIR;
  generatedCode: string;
  /** Kept so a caller wanting a different subset can regenerate faithfully. */
  options?: VirtualModuleOptions;
}

const TypeRegistry = new Map<string, RegisteredType>();

export function registerType(
  hash: string,
  ir: TypeIR,
  options?: VirtualModuleOptions
): RegisteredType {
  const existing = TypeRegistry.get(hash);
  if (existing) {
    // Generator-specific payloads (OpenAPI types/operations, protobuf schema
    // types) are not part of the type key, so they force a regeneration.
    const carriesGeneratorPayload =
      Boolean(options?.openApiTypes) ||
      Boolean(options?.service?.methods.length) ||
      Boolean(options?.protobufSchemaTypes?.length) ||
      Boolean(options?.avroSchemaTypes?.length);

    if (carriesGeneratorPayload) {
      const generatedCode = generateVirtualModuleCode(ir, options);
      const registered: RegisteredType = { ir, generatedCode, options };
      TypeRegistry.set(hash, registered);
      return registered;
    }
    return existing;
  }

  const generatedCode = generateVirtualModuleCode(ir, options);
  const registered: RegisteredType = { ir, generatedCode, options };
  TypeRegistry.set(hash, registered);
  return registered;
}

export function getTypeModule(hash: string): string | undefined {
  return TypeRegistry.get(hash)?.generatedCode;
}

/** The whole entry, for a caller that needs to regenerate a subset. */
export function getRegisteredType(hash: string): RegisteredType | undefined {
  return TypeRegistry.get(hash);
}

export function clearTypeRegistry(): void {
  TypeRegistry.clear();
}
