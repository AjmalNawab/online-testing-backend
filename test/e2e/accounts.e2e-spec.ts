import type { PGlite } from '@electric-sql/pglite';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthAdmin } from '../../src/accounts/auth-admin.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { TokenVerifier, type VerifiedToken } from '../../src/auth/token-verifier.js';
import { Database } from '../../src/database/database.js';
import { PgliteAuthAdmin, PgliteDatabase, createTestDb, createUser } from '../helpers/db.js';

const SETUP_CODE = 'correct-horse-battery';

class FakeVerifier extends TokenVerifier {
  users = new Map<string, VerifiedToken>();
  async verify(token: string) {
    return this.users.get(token) ?? null;
  }
}

let app: NestExpressApplication;
let http: Parameters<typeof request>[0];
let pglite: PGlite;
let authAdmin: PgliteAuthAdmin;
const verifier = new FakeVerifier();

/** Signs in as an existing auth user (the fake verifier accepts this token for them). */
async function tokenFor(email: string): Promise<{ Authorization: string }> {
  const row = (await pglite.query<{ id: string }>('select id from auth.users where email = $1', [email])).rows[0]!;
  const token = `token-${row.id}`;
  verifier.users.set(token, { userId: row.id, email });
  return { Authorization: `Bearer ${token}` };
}

const firstAdmin = { setup_code: SETUP_CODE, display_name: 'Ayesha Khan', email: 'Owner@School.example', password: 'a-long-password' };

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DISABLE_RATE_LIMIT: 'true',
    DATABASE_URL: 'postgresql://unused@localhost/unused',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key_000000',
    SUPABASE_SECRET_KEY: 'sb_secret_test_key_0000000000000',
    SETUP_CODE,
    EXPIRY_WORKER_ENABLED: 'false',
  });
  pglite = await createTestDb();
  authAdmin = new PgliteAuthAdmin(pglite);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Database)
    .useValue(new PgliteDatabase(pglite))
    .overrideProvider(TokenVerifier)
    .useValue(verifier)
    .overrideProvider(AuthAdmin)
    .useValue(authAdmin)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
  delete process.env.SETUP_CODE;
  delete process.env.SUPABASE_SECRET_KEY;
});

describe('first-run setup', () => {
  it('reports that setup is needed and available', async () => {
    const res = await request(http).get('/v1/setup').expect(200);
    expect(res.body).toEqual({ needs_setup: true, available: true });
  });

  it('rejects a wrong setup code without creating an account', async () => {
    const res = await request(http).post('/v1/setup').send({ ...firstAdmin, setup_code: 'wrong-code-123' }).expect(403);
    expect(res.body.error.code).toBe('INVALID_SETUP_CODE');
    expect(authAdmin.created).toHaveLength(0);
  });

  it('validates the form', async () => {
    const res = await request(http).post('/v1/setup').send({ ...firstAdmin, email: 'not-an-email', password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(authAdmin.created).toHaveLength(0);
  });

  it('creates the first administrator', async () => {
    const res = await request(http).post('/v1/setup').send(firstAdmin).expect(201);
    expect(res.body).toEqual({ email: 'owner@school.example' });

    const me = await request(http).get('/v1/auth/me').set(await tokenFor('owner@school.example')).expect(200);
    expect(me.body).toMatchObject({ role: 'admin', displayName: 'Ayesha Khan' });
    expect((await request(http).get('/v1/setup').expect(200)).body.needs_setup).toBe(false);
  });

  it('switches itself off once an admin exists', async () => {
    const res = await request(http).post('/v1/setup').send({ ...firstAdmin, email: 'intruder@example.com' }).expect(409);
    expect(res.body.error.code).toBe('SETUP_ALREADY_COMPLETE');
    const rows = await pglite.query('select 1 from auth.users where email = $1', ['intruder@example.com']);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('managing administrators', () => {
  const second = { display_name: 'Bilal', email: 'bilal@school.example', password: 'another-long-password' };

  it('requires an admin', async () => {
    await request(http).get('/v1/admin/admins').expect(401);
    await createUser(pglite, 'student@example.com');
    const student = await tokenFor('student@example.com');
    await request(http).get('/v1/admin/admins').set(student).expect(403);
    await request(http).post('/v1/admin/admins').set(student).send(second).expect(403);
    expect(authAdmin.created).toHaveLength(1); // only the setup account
  });

  it('adds, lists and removes administrators', async () => {
    const owner = await tokenFor('owner@school.example');
    const created = await request(http).post('/v1/admin/admins').set(owner).send(second).expect(201);
    expect(created.body).toMatchObject({ email: 'bilal@school.example', display_name: 'Bilal', is_you: false });

    const list = await request(http).get('/v1/admin/admins').set(owner).expect(200);
    expect(list.body.map((a: { email: string }) => a.email)).toEqual(['owner@school.example', 'bilal@school.example']);

    const bilal = await tokenFor('bilal@school.example');
    expect((await request(http).get('/v1/auth/me').set(bilal).expect(200)).body.role).toBe('admin');

    await request(http).delete(`/v1/admin/admins/${created.body.id}`).set(owner).expect(204);
    expect(authAdmin.deleted).toContain(created.body.id);
    expect((await request(http).get('/v1/admin/admins').set(owner).expect(200)).body).toHaveLength(1);
  });

  it('rejects a duplicate email', async () => {
    const owner = await tokenFor('owner@school.example');
    const res = await request(http).post('/v1/admin/admins').set(owner).send({ ...second, email: 'owner@school.example' }).expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('an admin cannot remove themselves', async () => {
    const owner = await tokenFor('owner@school.example');
    const me = await request(http).get('/v1/auth/me').set(owner).expect(200);
    const res = await request(http).delete(`/v1/admin/admins/${me.body.id}`).set(owner).expect(409);
    expect(res.body.error.code).toBe('CANNOT_REMOVE_SELF');
  });
});
