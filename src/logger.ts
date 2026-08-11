/**
 * Sink for everything the plugin reports. Mirrors the `console` shape so
 * `console` itself is a valid logger, and so pino/winston-style loggers drop in
 * without an adapter.
 */
export interface WizLogger {
  trace(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const noop = () => {};

/**
 * What the plugin uses when no logger is supplied.
 *
 * `trace` is a no-op on purpose: it fires once per documented route, and
 * `console.trace` appends a full stack to every message, so wiring it up by
 * default would bury a build in stack traces nobody asked for. Opt in with
 * {@link consoleLogger}, or map `trace` to a sink of your choosing.
 */
export const defaultLogger: WizLogger = {
  trace: noop,
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** Full console mirror, `console.trace` and all. Opt in for verbose builds. */
export const consoleLogger: WizLogger = {
  trace: (...args) => console.trace(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** Discards everything. Useful in tests and quiet CI builds. */
export const silentLogger: WizLogger = {
  trace: noop,
  info: noop,
  warn: noop,
  error: noop,
};
