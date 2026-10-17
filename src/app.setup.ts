import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { requestIdMiddleware } from './common/request-id.middleware.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';

export const API_PREFIX = 'v1';

/** Shared HTTP configuration for production and end-to-end tests. */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);

  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.use(requestIdMiddleware);
  app.use(
    helmet({
      // The API serves JSON (and Swagger UI at /docs, which needs inline assets).
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin header.
      if (!origin || config.corsOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Attempt-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    credentials: false,
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Online Test Platform API')
        .setDescription(
          'REST API for the online assessment platform.\n\n' +
            '**Admins** authenticate with a Supabase Auth access token: `Authorization: Bearer <jwt>`.\n\n' +
            '**Guests** start an attempt via `POST /v1/public/tests/{shareToken}/attempts` and then send the returned ' +
            'secret as `X-Attempt-Token` on every `/v1/attempts/*` request.\n\n' +
            'Errors always have the shape `{ "error": { "code", "message", "details?", "requestId" } }`.',
        )
        .setVersion('1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }
  return app;
}
