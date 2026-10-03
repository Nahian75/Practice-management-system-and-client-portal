import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { LOG_LEVELS, type Env } from './env.js';

export function enabledLogLevels(threshold: Env['LOG_LEVEL']): LogLevel[] {
  return LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(threshold) + 1);
}

export function createLogger(env: Env): ConsoleLogger {
  const isProduction = env.NODE_ENV === 'production';

  return new ConsoleLogger({
    json: isProduction,
    colors: !isProduction,
    logLevels: enabledLogLevels(env.LOG_LEVEL),
  });
}
