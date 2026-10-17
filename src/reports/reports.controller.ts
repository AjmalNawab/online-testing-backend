import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../auth/auth.guard.js';
import { ApiZodQuery, ZodQuery } from '../common/zod.js';
import type { DashboardStats, ProgressReport } from '../contracts/responses.js';
import { progressQuerySchema, resultsQuerySchema, type ResultsQuery } from '../contracts/test-schemas.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports (admin)')
@AdminOnly()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Dashboard counts, averages and recent attempts' })
  dashboard(): Promise<DashboardStats> {
    return this.reports.dashboard();
  }

  @Get('results.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="results.csv"')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Export attempts as CSV (same filters as /admin/attempts)' })
  @ApiZodQuery(resultsQuerySchema)
  async csv(@ZodQuery(resultsQuerySchema) query: ResultsQuery): Promise<string> {
    return '﻿' + (await this.reports.resultsCsv(query));
  }

  @Get('progress')
  @ApiOperation({ summary: 'Progress over time with recommendations based on stored results' })
  @ApiZodQuery(progressQuerySchema)
  progress(@ZodQuery(progressQuerySchema) query: { student?: string; subject_id?: string }): Promise<ProgressReport> {
    return this.reports.progress(query.student, query.subject_id);
  }
}
