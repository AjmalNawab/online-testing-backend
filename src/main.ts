import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/env.js';

// Last line of defence: a stray rejected promise in background work is logged
// instead of stopping the server (and every exam in progress).
process.on('unhandledRejection', (reason) => {
  new Logger('Process').error(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

async function bootstrap() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  loadConfig(); // fail fast with a readable message before Nest starts

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });
  configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on port ${config.port} (${config.nodeEnv})`);
  if (config.swaggerEnabled) logger.log(`API docs: ${config.appUrl ?? `http://localhost:${config.port}`}/docs`);
  logger.log(`CORS origins: ${config.corsOrigins.join(', ')}`);
  logger.log(config.ai.apiKey ? `AI: ${config.ai.provider} (${config.ai.model})` : 'AI: disabled (GEMINI_API_KEY not set)');
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
