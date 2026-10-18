import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module.js';
import { ClassesController, MyClassesController, TestAssignmentsController } from './classes.controller.js';
import { ClassesService } from './classes.service.js';

@Module({
  imports: [AttemptsModule],
  controllers: [ClassesController, TestAssignmentsController, MyClassesController],
  providers: [ClassesService],
})
export class ClassesModule {}
