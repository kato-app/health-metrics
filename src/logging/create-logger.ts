import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type Logger as PinoLogger, type StreamEntry } from "pino";
import pretty from "pino-pretty";
import type { LogContext, Logger, LoggerOptions } from "./logger.js";

class PinoBackedLogger implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  debug(message: string, context?: LogContext): void {
    this.pino.debug(context ?? {}, message);
  }
  info(message: string, context?: LogContext): void {
    this.pino.info(context ?? {}, message);
  }
  warn(message: string, context?: LogContext): void {
    this.pino.warn(context ?? {}, message);
  }
  error(message: string, context?: LogContext): void {
    this.pino.error(context ?? {}, message);
  }
  child(bindings: LogContext): Logger {
    return new PinoBackedLogger(this.pino.child(bindings));
  }
}

/**
 * Creates the application logger.
 *
 * - Console: human-readable lines at `consoleLevel` or above.
 * - File (optional): newline-delimited JSON at `debug`, appended across runs.
 *
 * Both streams are synchronous so a short-lived CLI never exits with buffered
 * lines unwritten. A future shipping transport is another entry in `streams`.
 */
export function createLogger(options: LoggerOptions): Logger {
  const streams: StreamEntry[] = [
    {
      level: options.consoleLevel,
      stream: pretty({ colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname", sync: true }),
    },
  ];

  if (options.file) {
    mkdirSync(path.dirname(options.file), { recursive: true });
    streams.push({
      level: "debug",
      stream: pino.destination({ dest: options.file, append: true, sync: true }),
    });
  }

  const root = pino({ level: "debug", base: null }, pino.multistream(streams));
  return new PinoBackedLogger(root);
}
