import { ApiError } from '@google/genai';
import { GeminiProvider } from '../../src/ai/gemini.provider.js';
import { settleWithLimit } from '../../src/ai/ai.service.js';
import { AppError } from '../../src/common/errors.js';
import { loadConfig } from '../../src/config/env.js';

type Call = { model: string; config: { thinkingConfig?: { thinkingLevel: string } } };

function providerWith(responses: (() => unknown)[], env: Record<string, string> = {}) {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://u@localhost/db',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key_000000',
    GEMINI_API_KEY: 'test-key-123456',
    ...env,
  });
  const provider = new GeminiProvider(config);
  const calls: Call[] = [];
  const ok = { text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
  Object.assign(provider, {
    client: {
      models: {
        generateContent: async (req: Call) => {
          calls.push(req);
          const next = responses.shift();
          if (next) return next();
          return ok;
        },
      },
    },
  });
  return { provider, calls };
}

const request = { task: 'generate-test', system: 's', prompt: 'p', schema: {}, maxOutputTokens: 100 };
const fail = (status: number, message = 'error') => () => {
  throw new ApiError({ status, message });
};

describe('Gemini provider', () => {
  it('asks for low thinking by default (much faster)', async () => {
    const { provider, calls } = providerWith([]);
    await provider.generateJson(request);
    expect(calls[0]!.config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('uses the configured thinking level', async () => {
    const { provider, calls } = providerWith([], { GEMINI_THINKING_LEVEL: 'high' });
    await provider.generateJson(request);
    expect(calls[0]!.config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
  });

  it('falls back once if the model does not support thinking settings, and remembers it', async () => {
    const { provider, calls } = providerWith([fail(400, 'Thinking level LOW is not supported for this model.')]);
    expect((await provider.generateJson(request)).json).toEqual({ ok: true });
    await provider.generateJson(request);
    expect(calls.map((c) => c.config.thinkingConfig ?? null)).toEqual([{ thinkingLevel: 'LOW' }, null, null]);
  });

  it('retries a Gemini 504 once, then reports a timeout', async () => {
    const retried = providerWith([fail(504)]);
    expect((await retried.provider.generateJson(request)).json).toEqual({ ok: true });

    const { provider } = providerWith([fail(504), fail(504)], { GEMINI_FALLBACK_MODELS: 'none' });
    const error = await provider.generateJson(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'AI_TIMEOUT', status: 504 });
  }, 15_000);
});

describe('Gemini model fallback', () => {
  const busy = fail(503, 'This model is currently experiencing high demand.');

  it('switches to the fallback model straight away when the main model is overloaded', async () => {
    const { provider, calls } = providerWith([busy], { GEMINI_MODEL: 'main-model', GEMINI_FALLBACK_MODELS: 'backup-model' });
    expect((await provider.generateJson(request)).json).toEqual({ ok: true });
    expect(calls.map((c) => c.model)).toEqual(['main-model', 'backup-model']);
  });

  it('tries an overloaded model last for a while', async () => {
    const { provider, calls } = providerWith([busy], { GEMINI_MODEL: 'main-model', GEMINI_FALLBACK_MODELS: 'backup-model' });
    await provider.generateJson(request);
    await provider.generateJson(request);
    expect(calls.map((c) => c.model)).toEqual(['main-model', 'backup-model', 'backup-model']);
  });

  it('reports "busy" when every model is overloaded', async () => {
    const { provider, calls } = providerWith([busy, busy, busy], { GEMINI_MODEL: 'main-model', GEMINI_FALLBACK_MODELS: 'backup-model' });
    const error = await provider.generateJson(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AI_BUSY', status: 503 });
    expect(calls.map((c) => c.model)).toEqual(['main-model', 'backup-model', 'backup-model']);
  }, 15_000);

  it('a missing fallback model does not hide that the main model was busy', async () => {
    const { provider } = providerWith([busy, fail(404, 'model not found')], { GEMINI_MODEL: 'main-model', GEMINI_FALLBACK_MODELS: 'gone-model' });
    const error = await provider.generateJson(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AI_BUSY' });
  });

  it('a used-up daily quota skips the model and says so', async () => {
    const quota = fail(429, 'You exceeded your current quota, please check your plan and billing details.');
    const { provider, calls } = providerWith([quota], { GEMINI_MODEL: 'main-model', GEMINI_FALLBACK_MODELS: 'backup-model' });
    expect((await provider.generateJson(request)).json).toEqual({ ok: true });
    expect(calls.map((c) => c.model)).toEqual(['main-model', 'backup-model']);

    const alone = providerWith([quota], { GEMINI_MODEL: 'main-model', GEMINI_FALLBACK_MODELS: 'none' });
    const error = await alone.provider.generateJson(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AI_QUOTA_EXCEEDED', status: 429 });
    expect(alone.calls).toHaveLength(1); // no pointless retry
  });

  it('"none" disables fallback', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://u@localhost/db',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key_000000',
      GEMINI_FALLBACK_MODELS: 'none',
    });
    expect(config.ai.fallbackModels).toEqual([]);
  });
});

describe('settleWithLimit', () => {
  it('keeps order, reports failures and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const results = await settleWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10 * (8 - n)));
      running--;
      if (n === 4) throw new Error('four');
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 30, 'x', 50, 60, 70]);
  });
});
