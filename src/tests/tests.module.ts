import { Module } from '@nestjs/common';
import { TestsController } from './tests.controller.js';
import { TestsService } from './tests.service.js';

@Module({
  controllers: [TestsController],
  providers: [TestsService],
  exports: [TestsService],
})
export class TestsModule {}
