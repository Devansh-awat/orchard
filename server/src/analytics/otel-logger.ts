import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { emitLog } from './telemetry';

/**
 * Nest logger that keeps console output and additionally forwards each log
 * record to OpenTelemetry → PostHog Logs. We extend ConsoleLogger so dev
 * ergonomics (colors, timestamps) are unchanged.
 */
export class OtelConsoleLogger extends ConsoleLogger {
  log(message: any, ...optionalParams: any[]) {
    super.log(message, ...optionalParams);
    this.forward('log', message, optionalParams);
  }
  error(message: any, ...optionalParams: any[]) {
    super.error(message, ...optionalParams);
    this.forward('error', message, optionalParams);
  }
  warn(message: any, ...optionalParams: any[]) {
    super.warn(message, ...optionalParams);
    this.forward('warn', message, optionalParams);
  }
  debug(message: any, ...optionalParams: any[]) {
    super.debug(message, ...optionalParams);
    this.forward('debug', message, optionalParams);
  }
  verbose(message: any, ...optionalParams: any[]) {
    super.verbose(message, ...optionalParams);
    this.forward('verbose', message, optionalParams);
  }
  fatal(message: any, ...optionalParams: any[]) {
    super.fatal?.(message, ...optionalParams);
    this.forward('fatal', message, optionalParams);
  }

  private forward(level: LogLevel | 'fatal', message: any, params: any[]) {
    const body = typeof message === 'string' ? message : safeStringify(message);
    // Nest's variadic convention: last string param is the "context" (logger
    // name, e.g. "AuthService"); a stack trace may precede it for errors.
    let context: string | undefined;
    let stack: string | undefined;
    if (params.length > 0 && typeof params[params.length - 1] === 'string') {
      context = params[params.length - 1];
      if (params.length > 1 && typeof params[params.length - 2] === 'string') {
        stack = params[params.length - 2];
      }
    }
    emitLog(level, body, {
      ...(context ? { 'logger.name': context } : {}),
      ...(stack ? { 'exception.stacktrace': stack } : {}),
    });
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
