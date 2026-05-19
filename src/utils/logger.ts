import winston from 'winston';

const { combine, timestamp, json, colorize, simple } = winston.format;

const isProduction = process.env['NODE_ENV'] === 'production';

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  defaultMeta: { service: 'mcp-live-db-stream' },
  format: isProduction
    ? combine(timestamp(), json())
    : combine(colorize(), timestamp(), simple()),
  transports: [new winston.transports.Console()],
});

export function childLogger(requestId: string): winston.Logger {
  return logger.child({ requestId });
}
