import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AttemptsService } from '../attempts/attempts.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { assertClassInScope, assertTestInScope, type Scope } from '../auth/scope.js';
import { AppError, notFound } from '../common/errors.js';
import { JOIN_CODE_ALPHABET } from '../contracts/class-schemas.js';
import type { TestStatus } from '../contracts/constants.js';
import type { ClassDetail, ClassSummary, MyAssignment, MyClass, TestAssignment } from '../contracts/responses.js';
import { Database } from '../database/database.js';

type ClassRow = {
  id: string;
  name: string;
  description: string | null;
  join_code: string;
  archived_at: string | null;
  teacher_id: string;
  teacher_name: string;
  member_count: number;
  test_count: number;
  created_at: string;
};

const CLASS_SELECT = `
  select c.id, c.name, c.description, c.join_code, c.archived_at, c.teacher_id, c.created_at,
         p.display_name as teacher_name,
         (select count(*) from public.class_members m where m.class_id = c.id) as member_count,
         (select count(*) from public.test_assignments ta where ta.class_id = c.id) as test_count
  from public.classes c
  join public.profiles p on p.id = c.teacher_id`;

const toSummary = (r: ClassRow): ClassSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  join_code: r.join_code,
  archived: r.archived_at !== null,
  teacher: { id: r.teacher_id, name: r.teacher_name },
  member_count: Number(r.member_count),
  test_count: Number(r.test_count),
  created_at: r.created_at,
});

/** Submitted attempts by members of the class, counted once per student. */
const SUBMITTED_COUNT = `
  (select count(distinct a.student_id) from public.test_attempts a
   join public.class_members m on m.student_id = a.student_id and m.class_id = ta.class_id
   where a.test_id = ta.test_id and a.status <> 'in_progress')`;

function generateJoinCode(): string {
  return Array.from({ length: 8 }, () => JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)]).join('');
}

@Injectable()
export class ClassesService {
  constructor(
    private readonly db: Database,
    private readonly attempts: AttemptsService,
  ) {}

  // ------------------------------------------------------------- teachers ---

  async list(scope: Scope, includeArchived: boolean): Promise<ClassSummary[]> {
    const rows = await this.db.query<ClassRow>(
      `${CLASS_SELECT}
       where ($1::boolean or c.teacher_id = $2) and ($3::boolean or c.archived_at is null)
       order by c.archived_at nulls first, c.created_at desc`,
      [scope.isAdmin, scope.userId, includeArchived],
    );
    return rows.map(toSummary);
  }

  async get(scope: Scope, id: string): Promise<ClassDetail> {
    await assertClassInScope(this.db, scope, id);
    const row = await this.db.one<ClassRow>(`${CLASS_SELECT} where c.id = $1`, [id]);
    if (!row) throw notFound('Class');
    const [members, assignments] = await Promise.all([
      this.db.query<ClassDetail['members'][number]>(
        `select p.id, p.display_name, u.email, m.joined_at
         from public.class_members m
         join public.profiles p on p.id = m.student_id
         join auth.users u on u.id = p.id
         where m.class_id = $1 order by lower(p.display_name), u.email`,
        [id],
      ),
      this.db.query<{ test_id: string; title: string; status: TestStatus; due_at: string | null; submitted_count: number }>(
        `select ta.test_id, t.title, t.status, ta.due_at, ${SUBMITTED_COUNT} as submitted_count
         from public.test_assignments ta join public.tests t on t.id = ta.test_id
         where ta.class_id = $1 order by ta.due_at nulls last, ta.created_at desc`,
        [id],
      ),
    ]);
    return {
      ...toSummary(row),
      members,
      assignments: assignments.map((a) => ({ ...a, submitted_count: Number(a.submitted_count) })),
    };
  }

  async create(scope: Scope, input: { name: string; description: string | null }): Promise<ClassDetail> {
    // Retry on the (very unlikely) chance of a join-code collision.
    for (let i = 0; ; i++) {
      try {
        const row = await this.db.one<{ id: string }>(
          `insert into public.classes (teacher_id, name, description, join_code) values ($1, $2, $3, $4) returning id`,
          [scope.userId, input.name, input.description, generateJoinCode()],
        );
        return this.get(scope, row!.id);
      } catch (error) {
        if (i >= 4 || !(error instanceof Error && 'sqlState' in error && error.sqlState === '23505')) throw error;
      }
    }
  }

  async update(scope: Scope, id: string, patch: { name?: string; description?: string | null; archived?: boolean }): Promise<ClassDetail> {
    await assertClassInScope(this.db, scope, id);
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (patch.name !== undefined) sets.push(`name = $${values.push(patch.name)}`);
    if (patch.description !== undefined) sets.push(`description = $${values.push(patch.description)}`);
    if (patch.archived !== undefined) sets.push(patch.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = null');
    if (sets.length) await this.db.query(`update public.classes set ${sets.join(', ')} where id = $1`, values);
    return this.get(scope, id);
  }

  async resetCode(scope: Scope, id: string): Promise<ClassDetail> {
    await assertClassInScope(this.db, scope, id);
    for (let i = 0; ; i++) {
      try {
        await this.db.query('update public.classes set join_code = $2 where id = $1', [id, generateJoinCode()]);
        return this.get(scope, id);
      } catch (error) {
        if (i >= 4 || !(error instanceof Error && 'sqlState' in error && error.sqlState === '23505')) throw error;
      }
    }
  }

  async remove(scope: Scope, id: string): Promise<void> {
    await assertClassInScope(this.db, scope, id);
    await this.db.query('delete from public.classes where id = $1', [id]);
  }

  async addMember(scope: Scope, classId: string, email: string): Promise<ClassDetail> {
    await assertClassInScope(this.db, scope, classId);
    const student = await this.db.one<{ id: string }>(
      `select p.id from auth.users u join public.profiles p on p.id = u.id
       where lower(u.email) = lower($1) and p.role = 'student'`,
      [email],
    );
    if (!student) {
      throw new AppError('STUDENT_NOT_FOUND', 404, 'No student account uses this email. Ask the student to sign up first, or share the class code.');
    }
    await this.db.query(
      'insert into public.class_members (class_id, student_id) values ($1, $2) on conflict do nothing',
      [classId, student.id],
    );
    return this.get(scope, classId);
  }

  async removeMember(scope: Scope, classId: string, studentId: string): Promise<ClassDetail> {
    await assertClassInScope(this.db, scope, classId);
    await this.db.query('delete from public.class_members where class_id = $1 and student_id = $2', [classId, studentId]);
    return this.get(scope, classId);
  }

  // ---------------------------------------------------------- assignments ---

  async listForTest(scope: Scope, testId: string): Promise<TestAssignment[]> {
    await assertTestInScope(this.db, scope, testId);
    const rows = await this.db.query<TestAssignment>(
      `select ta.class_id, c.name as class_name, ta.due_at,
              (select count(*) from public.class_members m where m.class_id = ta.class_id) as member_count,
              ${SUBMITTED_COUNT} as submitted_count
       from public.test_assignments ta join public.classes c on c.id = ta.class_id
       where ta.test_id = $1 order by lower(c.name)`,
      [testId],
    );
    return rows.map((r) => ({ ...r, member_count: Number(r.member_count), submitted_count: Number(r.submitted_count) }));
  }

  async assign(scope: Scope, testId: string, input: { class_id: string; due_at: string | null }, actorId: string): Promise<TestAssignment[]> {
    await assertTestInScope(this.db, scope, testId);
    await assertClassInScope(this.db, scope, input.class_id);
    await this.db.query(
      `insert into public.test_assignments (test_id, class_id, due_at, created_by) values ($1, $2, $3, $4)
       on conflict (test_id, class_id) do update set due_at = excluded.due_at`,
      [testId, input.class_id, input.due_at, actorId],
    );
    return this.listForTest(scope, testId);
  }

  async unassign(scope: Scope, testId: string, classId: string): Promise<TestAssignment[]> {
    await assertTestInScope(this.db, scope, testId);
    await this.db.query('delete from public.test_assignments where test_id = $1 and class_id = $2', [testId, classId]);
    return this.listForTest(scope, testId);
  }

  // ------------------------------------------------------------- students ---

  async join(user: AuthUser, code: string): Promise<MyClass> {
    if (user.role !== 'student') {
      throw new AppError('ONLY_STUDENTS_JOIN', 403, 'Only student accounts can join a class.');
    }
    const cls = await this.db.one<{ id: string }>(
      'select id from public.classes where join_code = $1 and archived_at is null',
      [code],
    );
    if (!cls) throw new AppError('CLASS_NOT_FOUND', 404, 'No class uses this code. Check it with your teacher.');
    await this.db.query(
      'insert into public.class_members (class_id, student_id) values ($1, $2) on conflict do nothing',
      [cls.id, user.id],
    );
    return (await this.myClasses(user.id)).find((c) => c.id === cls.id)!;
  }

  myClasses(studentId: string): Promise<MyClass[]> {
    return this.db.query<MyClass>(
      `select c.id, c.name, p.display_name as teacher_name, m.joined_at
       from public.class_members m
       join public.classes c on c.id = m.class_id and c.archived_at is null
       join public.profiles p on p.id = c.teacher_id
       where m.student_id = $1 order by m.joined_at desc`,
      [studentId],
    );
  }

  async leave(studentId: string, classId: string): Promise<void> {
    await this.db.query('delete from public.class_members where class_id = $1 and student_id = $2', [classId, studentId]);
  }

  async myAssignments(studentId: string): Promise<MyAssignment[]> {
    await this.attempts.finalizeExpired(20).catch(() => undefined);
    const rows = await this.db.query<
      Omit<MyAssignment, 'state'> & { latest_status: string | null }
    >(
      `select distinct on (t.id)
              t.id as test_id, t.title, s.name as subject, t.duration_minutes, t.share_token,
              c.name as class_name, ta.due_at, la.id as latest_attempt_id, la.status as latest_status
       from public.class_members m
       join public.classes c on c.id = m.class_id and c.archived_at is null
       join public.test_assignments ta on ta.class_id = c.id
       join public.tests t on t.id = ta.test_id and t.status = 'published'
       join public.subjects s on s.id = t.subject_id
       left join lateral (
         select a.id, a.status from public.test_attempts a
         where a.test_id = t.id and a.student_id = m.student_id
         order by a.started_at desc limit 1
       ) la on true
       where m.student_id = $1
       order by t.id, ta.due_at nulls last`,
      [studentId],
    );
    const items: MyAssignment[] = rows.map(({ latest_status, ...r }) => ({
      ...r,
      state: latest_status === null ? 'not_started' : latest_status === 'in_progress' ? 'in_progress' : 'submitted',
    }));
    // To do first (soonest due), then finished ones.
    const rank = { in_progress: 0, not_started: 1, submitted: 2 } as const;
    return items.sort(
      (a, b) =>
        rank[a.state] - rank[b.state] ||
        (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') ||
        a.title.localeCompare(b.title),
    );
  }
}

