import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { TestsModule } from '../tests/tests.module.js';
import { AiProvider } from './ai-provider.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AutoGradeWorker } from './auto-grade.worker.js';
import { GeminiProvider } from './gemini.provider.js';

@Module({
  imports: [AttemptsModule, CatalogModule, ReviewsModule, TestsModule],
  controllers: [AiController],
  providers: [AiService, AutoGradeWorker, { provide: AiProvider, useClass: GeminiProvider }],
})
export class AiModule {}
