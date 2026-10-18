import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from './accounts/accounts.module.js';
import { AiModule } from './ai/ai.module.js';
import { AttemptsModule } from './attempts/attempts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ClassesModule } from './classes/classes.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { ReportsModule } from './reports/reports.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { StudentsModule } from './students/students.module.js';
import { TestsModule } from './tests/tests.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ScheduleModule.forRoot(),
    // Default: 300 requests/minute per client IP; sensitive routes set stricter limits.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
      // Test-only escape hatch; ignored outside NODE_ENV=test.
      skipIf: () => process.env.NODE_ENV === 'test' && process.env.DISABLE_RATE_LIMIT === 'true',
    }),
    AuthModule,
    AccountsModule,
    CatalogModule,
    TestsModule,
    AttemptsModule,
    ReviewsModule,
    ReportsModule,
    AiModule,
    StudentsModule,
    ClassesModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
