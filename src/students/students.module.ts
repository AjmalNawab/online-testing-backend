import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { StudentsController } from './students.controller.js';
import { StudentsService } from './students.service.js';

@Module({
  imports: [AttemptsModule, ReportsModule],
  controllers: [StudentsController],
  providers: [StudentsService],
})
export class StudentsModule {}
