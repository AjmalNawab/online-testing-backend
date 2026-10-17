import { Module } from '@nestjs/common';
import { AttemptsController } from './attempts.controller.js';
import { AttemptsService } from './attempts.service.js';
import { ExpiryWorker } from './expiry.worker.js';
import { PublicController } from './public.controller.js';

@Module({
  controllers: [PublicController, AttemptsController],
  providers: [AttemptsService, ExpiryWorker],
  exports: [AttemptsService],
})
export class AttemptsModule {}
