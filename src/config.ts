import 'dotenv/config';
import { z } from 'zod';
import type { AppConfig } from './types/index.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  SESSION_TTL_MS: z.coerce.number().int().positive().default(3600000),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  MAX_WATCHERS_PER_SESSION: z.coerce.number().int().positive().default(10),
  CHANGE_LOG_MAX_SIZE: z.coerce.number().int().positive().default(100),
  EVENT_MAX_AGE_MS: z.coerce.number().int().positive().default(300000),
  EVENT_MAX_COUNT: z.coerce.number().int().positive().default(1000),
  CORS_ORIGINS: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

let parsed: z.infer<typeof envSchema>;
try {
  parsed = envSchema.parse(process.env);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', err);
  process.exit(1);
}

export const config: AppConfig = {
  port: parsed.PORT,
  logLevel: parsed.LOG_LEVEL,
  sessionTtlMs: parsed.SESSION_TTL_MS,
  cleanupIntervalMs: parsed.CLEANUP_INTERVAL_MS,
  maxWatchersPerSession: parsed.MAX_WATCHERS_PER_SESSION,
  changeLogMaxSize: parsed.CHANGE_LOG_MAX_SIZE,
  eventMaxAgeMs: parsed.EVENT_MAX_AGE_MS,
  eventMaxCount: parsed.EVENT_MAX_COUNT,
  corsOrigins: parsed.CORS_ORIGINS === '*' ? ['*'] : parsed.CORS_ORIGINS.split(',').map(s => s.trim()),
  rateLimit: {
    windowMs: parsed.RATE_LIMIT_WINDOW_MS,
    max: parsed.RATE_LIMIT_MAX,
  },
};
