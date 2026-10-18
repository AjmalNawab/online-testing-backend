import type { SchedulerRegistry } from '@nestjs/schedule';
import type { AiService } from '../../src/ai/ai.service.js';
import { AutoGradeWorker } from '../../src/ai/auto-grade.worker.js';
import type { AttemptsService } from '../../src/attempts/attempts.service.js';
import { ExpiryWorker } from '../../src/attempts/expiry.worker.js';
import type { AppConfig } from '../../src/config/env.js';
import { DbError } from '../../src/common/errors.js';

const config = { ai: { apiKey: 'k' }, expiryWorker: { enabled: true, intervalSeconds: 30 } } as AppConfig;
const scheduler = {} as SchedulerRegistry;
const dbDown = () => Promise.reject(new DbError('Connection terminated due to connection timeout'));

describe('background workers survive database outages', () => {
  it('auto-grading: a failed run is logged, not thrown, and the next run still happens', async () => {
    let calls = 0;
    const ai = { autoGradePending: () => (calls++ === 0 ? dbDown() : Promise.resolve(0)) } as unknown as AiService;
    const worker = new AutoGradeWorker(ai, scheduler, config);
    await expect(worker.tick()).resolves.toBeUndefined();
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('expiry: a failed run is logged, not thrown', async () => {
    const attempts = { finalizeExpired: dbDown } as unknown as AttemptsService;
    await expect(new ExpiryWorker(attempts, scheduler, config).tick()).resolves.toBeUndefined();
  });
});
