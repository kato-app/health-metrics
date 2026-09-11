/**
 * Application-facing logging contract. Nothing outside `src/logging` should
 * import a concrete logging library; swap the implementation (or add a
 * shipping transport) behind `createLogger` without touching callers.
 */
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that attaches `bindings` to every line it emits. */
  child(bindings: LogContext): Logger;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** Absolute path of the JSON log file. Omit to disable file logging. */
  file?: string;
  /** Minimum level printed to the console. The file always receives `debug`. */
  consoleLevel: LogLevel;
}

/** A logger that discards everything. Useful in tests. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

/** Normalises an unknown thrown value into loggable context, following the `cause` chain. */
export function errorContext(err: unknown): LogContext {
  return { error: describeError(err) };
}

function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause !== undefined && { cause: describeError(err.cause) }),
  };
}
