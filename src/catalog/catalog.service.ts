import { Injectable } from '@nestjs/common';
import { AppError, notFound } from '../common/errors.js';
import type { Category, Subject, Tag, Topic } from '../contracts/responses.js';
import { Database } from '../database/database.js';

type SubjectDbRow = { id: string; name: string; slug: string; description: string | null; archived_at: string | null; topic_count: number; test_count: number };
type TopicDbRow = { id: string; subject_id: string; name: string; description: string | null; archived_at: string | null };

const toSubject = (r: SubjectDbRow): Subject => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  archived: r.archived_at !== null,
  topic_count: Number(r.topic_count),
  test_count: Number(r.test_count),
});

const toTopic = (r: TopicDbRow): Topic => ({
  id: r.id,
  subject_id: r.subject_id,
  name: r.name,
  description: r.description,
  archived: r.archived_at !== null,
});

const SUBJECT_SELECT = `
  select s.id, s.name, s.slug, s.description, s.archived_at,
         (select count(*) from public.topics t where t.subject_id = s.id) as topic_count,
         (select count(*) from public.tests x where x.subject_id = s.id) as test_count
  from public.subjects s`;

@Injectable()
export class CatalogService {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------- subjects ---

  async listSubjects(includeArchived: boolean): Promise<Subject[]> {
    const rows = await this.db.query<SubjectDbRow>(
      `${SUBJECT_SELECT} ${includeArchived ? '' : 'where s.archived_at is null'} order by lower(s.name)`,
    );
    return rows.map(toSubject);
  }

  async getSubject(id: string): Promise<Subject> {
    const row = await this.db.one<SubjectDbRow>(`${SUBJECT_SELECT} where s.id = $1`, [id]);
    if (!row) throw notFound('Subject');
    return toSubject(row);
  }

  async createSubject(input: { name: string; description: string | null }, actorId: string): Promise<Subject> {
    const row = await this.db.one<{ id: string }>(
      `insert into public.subjects (name, slug, description, created_by)
       values ($1, public.slugify($1) || case when exists (select 1 from public.subjects where slug = public.slugify($1))
                                              then '-' || substr(md5(random()::text), 1, 6) else '' end, $2, $3)
       returning id`,
      [input.name, input.description, actorId],
    );
    return this.getSubject(row!.id);
  }

  /** Finds a subject by name (case-insensitive) or creates it — used by AI generation. */
  async findOrCreateSubject(name: string, actorId: string): Promise<string> {
    const existing = await this.db.one<{ id: string }>(
      `select id from public.subjects where lower(btrim(name)) = lower(btrim($1))`,
      [name],
    );
    if (existing) return existing.id;
    return (await this.createSubject({ name, description: null }, actorId)).id;
  }

  async findOrCreateTopic(subjectId: string, name: string): Promise<string> {
    const existing = await this.db.one<{ id: string }>(
      `select id from public.topics where subject_id = $1 and lower(btrim(name)) = lower(btrim($2))`,
      [subjectId, name],
    );
    if (existing) return existing.id;
    return (await this.createTopic(subjectId, { name, description: null })).id;
  }

  async updateSubject(id: string, patch: { name?: string; description?: string | null; archived?: boolean }): Promise<Subject> {
    const row = await this.db.one<{ id: string }>(
      `update public.subjects set
         name = coalesce($2, name),
         description = case when $3::boolean then $4 else description end,
         archived_at = case when $5::boolean is null then archived_at when $5 then coalesce(archived_at, now()) else null end
       where id = $1 returning id`,
      [id, patch.name ?? null, patch.description !== undefined, patch.description ?? null, patch.archived ?? null],
    );
    if (!row) throw notFound('Subject');
    return this.getSubject(id);
  }

  async deleteSubject(id: string): Promise<void> {
    const subject = await this.getSubject(id);
    if (subject.test_count > 0) {
      throw new AppError('IN_USE', 409, 'This subject has tests. Archive it instead, or move its tests first.');
    }
    await this.db.query('delete from public.subjects where id = $1', [id]);
  }

  // --------------------------------------------------------------- topics ---

  async listTopics(subjectId: string, includeArchived: boolean): Promise<Topic[]> {
    await this.getSubject(subjectId);
    const rows = await this.db.query<TopicDbRow>(
      `select id, subject_id, name, description, archived_at from public.topics
       where subject_id = $1 ${includeArchived ? '' : 'and archived_at is null'} order by lower(name)`,
      [subjectId],
    );
    return rows.map(toTopic);
  }

  async createTopic(subjectId: string, input: { name: string; description: string | null }): Promise<Topic> {
    await this.getSubject(subjectId);
    const row = await this.db.one<TopicDbRow>(
      `insert into public.topics (subject_id, name, description) values ($1, $2, $3)
       returning id, subject_id, name, description, archived_at`,
      [subjectId, input.name, input.description],
    );
    return toTopic(row!);
  }

  async updateTopic(id: string, patch: { name?: string; description?: string | null; archived?: boolean }): Promise<Topic> {
    const row = await this.db.one<TopicDbRow>(
      `update public.topics set
         name = coalesce($2, name),
         description = case when $3::boolean then $4 else description end,
         archived_at = case when $5::boolean is null then archived_at when $5 then coalesce(archived_at, now()) else null end
       where id = $1 returning id, subject_id, name, description, archived_at`,
      [id, patch.name ?? null, patch.description !== undefined, patch.description ?? null, patch.archived ?? null],
    );
    if (!row) throw notFound('Topic');
    return toTopic(row);
  }

  async deleteTopic(id: string): Promise<void> {
    const rows = await this.db.query('delete from public.topics where id = $1 returning id', [id]);
    if (rows.length === 0) throw notFound('Topic');
  }

  // ----------------------------------------------------------- categories ---

  listCategories(): Promise<Category[]> {
    return this.db.query<Category>('select id, name, description from public.categories order by lower(name)');
  }

  async createCategory(input: { name: string; description: string | null }): Promise<Category> {
    return (await this.db.one<Category>(
      'insert into public.categories (name, description) values ($1, $2) returning id, name, description',
      [input.name, input.description],
    ))!;
  }

  async updateCategory(id: string, patch: { name?: string; description?: string | null }): Promise<Category> {
    const row = await this.db.one<Category>(
      `update public.categories set name = coalesce($2, name),
         description = case when $3::boolean then $4 else description end
       where id = $1 returning id, name, description`,
      [id, patch.name ?? null, patch.description !== undefined, patch.description ?? null],
    );
    if (!row) throw notFound('Category');
    return row;
  }

  async deleteCategory(id: string): Promise<void> {
    const rows = await this.db.query('delete from public.categories where id = $1 returning id', [id]);
    if (rows.length === 0) throw notFound('Category');
  }

  // ----------------------------------------------------------------- tags ---

  listTags(): Promise<Tag[]> {
    return this.db.query<Tag>(
      `select t.id, t.name from public.tags t
       where exists (select 1 from public.test_tags tt where tt.tag_id = t.id)
       order by lower(t.name)`,
    );
  }
}
