import type { ApiIR } from '../ir/api.ts';
import type { ServiceIR } from '../ir/service.ts';
import type { TypeIR } from '../ir/types.ts';
import { defaultLogger, type WizLogger } from '../logger.ts';

/**
 * The pluggable emitter boundary.
 *
 * A generator is addressed by the IR root it understands, not by the call that
 * produced it: `TypeIR` for one type, `ServiceIR` for a set of endpoints, and
 * `ApiIR` for a whole document. The three are disjoint on `kind`, so one entry
 * point can hand any of them to any generator and say precisely what a
 * generator cannot do rather than emitting something empty.
 */

/** What a generator produces: file name to file contents. */
export type GeneratedFiles = Record<string, string>;

export type GeneratorInput = TypeIR | ServiceIR | ApiIR;

export interface GeneratorContext<TOptions> {
  options: TOptions;
  /**
   * Where a generator reports what it could not express. Dropping a media type
   * or an unnameable operation is a fact the caller needs, and silence is the
   * wrong failure mode for it.
   */
  logger: WizLogger;
}

/**
 * Every root is optional: a client emitter reads documents, a codec emitter
 * reads types, and neither has to pretend to handle the other.
 */
export interface Generator<TOptions = Record<string, never>> {
  /** Used in diagnostics, so it should name the output, not the file. */
  name: string;
  type?(ir: TypeIR, context: GeneratorContext<TOptions>): GeneratedFiles;
  service?(ir: ServiceIR, context: GeneratorContext<TOptions>): GeneratedFiles;
  api?(ir: ApiIR, context: GeneratorContext<TOptions>): GeneratedFiles;
}

function unsupported(generator: Generator<never>, kind: string): Error {
  const roots = [
    generator.type ? 'a type' : undefined,
    generator.service ? 'a service' : undefined,
    generator.api ? 'an API document' : undefined,
  ].filter((root): root is string => root !== undefined);

  return new Error(
    `[wiz] generator '${generator.name}' cannot generate from '${kind}'; ${
      roots.length > 0 ? `it reads ${roots.join(' or ')}` : 'it declares no inputs at all'
    }`
  );
}

/**
 * Runs one generator over one IR root.
 *
 * `options` is the generator's own, passed through untouched: the dispatcher
 * has no opinion on what a generator is configurable with.
 */
export function generate<TOptions>(
  ir: GeneratorInput,
  generator: Generator<TOptions>,
  options: TOptions,
  logger: WizLogger = defaultLogger
): GeneratedFiles {
  const context: GeneratorContext<TOptions> = { options, logger };
  const declared = generator as Generator<never>;

  if (ir.kind === 'api') {
    if (!generator.api) {
      throw unsupported(declared, ir.kind);
    }
    return generator.api(ir, context);
  }

  if (ir.kind === 'service') {
    if (!generator.service) {
      throw unsupported(declared, ir.kind);
    }
    return generator.service(ir, context);
  }

  if (!generator.type) {
    throw unsupported(declared, ir.kind);
  }
  return generator.type(ir, context);
}
