import { Controller, Get, HttpException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Database } from '../database/database.js';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (checks the database)' })
  async ready() {
    try {
      const row = await this.db.one<{ now: string }>('select now() as now');
      return { status: 'ok', database: 'ok', database_time: row?.now };
    } catch {
      throw new HttpException({ status: 'error', database: 'unreachable' }, 503);
    }
  }
}
