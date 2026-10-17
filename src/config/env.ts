import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Public URL of this API, used in docs and logs. */
    APP_URL: z.url().optional(),
    /** Postgres connection string (Supabase pooler URL in production). */
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'Must be a postgres:// connection string'),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_SSL: booleanString.default(true),
    SUPABASE_URL: z.url(),
    /** Public key, used only to verify admin access tokens with Supabase Auth. */
    SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional(),
    SUPABASE_ANON_KEY: z.string().min(20).optional(),
    /** Secret (service) key, used only to create and delete administrator accounts. */
    SUPABASE_SECRET_KEY: z.string().min(20).optional(),
    /** One-time code required to create the first administrator in the browser. */
    SETUP_CODE: z.string().min(12, 'Use at least 12 characters').max(200).optional(),
    /** Comma-separated list of allowed browser origins. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    /** Google Gemini API key. AI features are disabled when it is not set. */
    GEMINI_API_KEY: z.string().min(10).optional(),
    GEMINI_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default('gemini-3.7-flash'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(180_000),
    /** Max AI calls per admin per 24 hours (cost guard). */
    AI_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
    EXPIRY_WORKER_ENABLED: booleanString.default(true),
    EXPIRY_WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    /** Number of reverse proxies in front of the app (Railway: 1). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    SWAGGER_ENABLED: booleanString.default(true),
  })
  .refine((e) => e.SUPABASE_PUBLISHABLE_KEY || e.SUPABASE_ANON_KEY, {
    message: 'Set SUPABASE_PUBLISHABLE_KEY (or the legacy SUPABASE_ANON_KEY)',
    path: ['SUPABASE_PUBLISHABLE_KEY'],
  });

export type Env = z.output<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  isProduction: boolean;
  port: number;
  appUrl: string | undefined;
  databaseUrl: string;
  databasePoolSize: number;
  databaseSsl: boolean;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string | undefined;
  setupCode: string | undefined;
  corsOrigins: string[];
  ai: { provider: 'gemini'; apiKey: string | undefined; model: string; timeoutMs: number; dailyLimit: number };
  expiryWorker: { enabled: boolean; intervalSeconds: number };
  trustProxyHops: number;
  swaggerEnabled: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Validates the environment once at startup and fails fast with a readable message. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Blank lines such as `GEMINI_API_KEY=` mean "not set".
  const values = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(values);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example for the required variables.`);
  }
  const e = parsed.data;
  const corsOrigins = e.CORS_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (e.NODE_ENV === 'production' && corsOrigins.some((o) => o === '*')) {
    throw new Error('CORS_ORIGINS must list explicit origins in production (no "*").');
  }
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    appUrl: e.APP_URL,
    databaseUrl: e.DATABASE_URL,
    databasePoolSize: e.DATABASE_POOL_SIZE,
    databaseSsl: e.DATABASE_SSL,
    supabaseUrl: e.SUPABASE_URL,
    supabasePublishableKey: (e.SUPABASE_PUBLISHABLE_KEY ?? e.SUPABASE_ANON_KEY)!,
    supabaseSecretKey: e.SUPABASE_SECRET_KEY,
    setupCode: e.SETUP_CODE,
    corsOrigins,
    ai: {
      provider: 'gemini',
      apiKey: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
      dailyLimit: e.AI_DAILY_LIMIT,
    },
    expiryWorker: { enabled: e.EXPIRY_WORKER_ENABLED, intervalSeconds: e.EXPIRY_WORKER_INTERVAL_SECONDS },
    trustProxyHops: e.TRUST_PROXY_HOPS,
    swaggerEnabled: e.SWAGGER_ENABLED,
  };
}
