import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AiService } from './ai.service.js';

/** Applies AI marks automatically, only for tests configured not to require manual review. */
@Injectable()
export class AutoGradeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AutoGradeWorker.name);
  private running = false;

  constructor(
    private readonly ai: AiService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.ai.apiKey || !this.config.expiryWorker.enabled) return;
    const interval = setInterval(() => void this.tick(), 60_000);
    interval.unref();
    this.scheduler.addInterval('ai-auto-grade', interval);
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', 'ai-auto-grade')) this.scheduler.deleteInterval('ai-auto-grade');
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.ai.autoGradePending(5);
      if (n) this.logger.log(`Auto-graded ${n} written answer(s)`);
    } finally {
      this.running = false;
    }
  }
}
