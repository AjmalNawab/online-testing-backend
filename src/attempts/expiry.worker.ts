import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AttemptsService } from './attempts.service.js';

/**
 * Background expiry processor. Every N seconds it finalises attempts whose
 * deadline has passed (closed browsers, lost connections) and re-grades any
 * attempt left mid-grading by a crash. Deadlines live in the database, so a
 * restart loses nothing: the first run after boot catches up. Concurrent
 * runs (several instances) are safe because finalisation is idempotent and
 * row-locked in the database.
 */
@Injectable()
export class ExpiryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpiryWorker.name);
  private running = false;

  constructor(
    private readonly attempts: AttemptsService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.expiryWorker.enabled) {
      this.logger.warn('Expiry worker disabled (EXPIRY_WORKER_ENABLED=false). Expired attempts are finalised on access only.');
      return;
    }
    const interval = setInterval(() => void this.tick(), this.config.expiryWorker.intervalSeconds * 1000);
    interval.unref();
    this.scheduler.addInterval('attempt-expiry', interval);
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', 'attempt-expiry')) this.scheduler.deleteInterval('attempt-expiry');
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { finalized, failed } = await this.attempts.finalizeExpired(100);
      if (finalized || failed) this.logger.log(`Finalised ${finalized} expired attempt(s); ${failed} failed`);
    } catch (error) {
      this.logger.error(`Expiry run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
