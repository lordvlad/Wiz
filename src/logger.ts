/**
 * Sink for everything reported by wiz (plugin, generators, runtime clients).
 * Compatible with `console`, `pino`, and `winston` loggers without adapters.
 */
export interface WizLogger {
    trace?(...args: unknown[]): void;
    debug?(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

const noop = () => {};

/**
 * Standard console-backed logger, compatible with console and pino.
 * `trace` and `debug` are safe no-ops unless explicitly defined or called on verbose loggers.
 */
export const consoleLogger: WizLogger = {
    trace: (...args: unknown[]) => (console.trace ? console.trace(...args) : console.log(...args)),
    debug: (...args: unknown[]) => (console.debug ? console.debug(...args) : console.log(...args)),
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
};

/**
 * Default logger for the plugin.
 * `trace` is a no-op to avoid noisy stack traces during builds.
 */
export const defaultLogger: WizLogger = {
    trace: noop,
    debug: noop,
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
};

/** Discards everything. Useful in tests and quiet CI builds. */
export const silentLogger: WizLogger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
};
