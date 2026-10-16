export interface EngineLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type EngineLoggerFactory = (context: string) => EngineLogger;

export const consoleLogger: EngineLoggerFactory = (context) => ({
  log: (message) => process.stdout.write(`[${context}] ${message}\n`),
  warn: (message) => console.warn(`[${context}] ${message}`),
  error: (message) => console.error(`[${context}] ${message}`)
});
