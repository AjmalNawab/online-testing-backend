import { questionInputSchema, type QuestionInput } from '../../src/contracts/question-schemas.js';
import { saveTestSchema } from '../../src/contracts/test-schemas.js';

const base = (o: Partial<QuestionInput>): QuestionInput => ({
  question_type: 'mcq_single',
  prompt: 'What is 2 + 2?',
  content: { options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }] },
  answer_key: { correct: 'b' },
  grading_method: 'auto',
  marks: 1,
  ...o,
});

const ok = (o: Partial<QuestionInput>) => questionInputSchema.safeParse(base(o)).success;
const messages = (o: Partial<QuestionInput>) => {
  const r = questionInputSchema.safeParse(base(o));
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('question validation', () => {
  it('accepts a valid MCQ and strips unknown content keys', () => {
    const r = questionInputSchema.parse(base({ content: { options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }], evil: 1 } }));
    expect(r.content).toEqual({ options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }] });
  });

  it('rejects an MCQ whose correct answer is not an option', () => {
    expect(messages({ answer_key: { correct: 'z' } })).toContain('Choose which option is correct');
  });

  it('rejects duplicate or too few options', () => {
    expect(ok({ content: { options: [{ id: 'a', text: 'x' }] }, answer_key: { correct: 'a' } })).toBe(false);
    expect(ok({ content: { options: [{ id: 'a', text: 'Same' }, { id: 'b', text: 'same' }] } })).toBe(false);
  });

  it('enforces grading method by type', () => {
    expect(ok({ grading_method: 'manual' })).toBe(false);
    expect(ok({ question_type: 'long_answer', content: {}, answer_key: {}, grading_method: 'auto' })).toBe(false);
    expect(ok({ question_type: 'long_answer', content: {}, answer_key: {}, grading_method: 'ai_assisted' })).toBe(true);
  });

  it('fill in the blanks: blanks in the prompt must match the answer key', () => {
    const fb = { question_type: 'fill_blank' as const, prompt: 'She ___ happy and ___ tired.' };
    expect(ok({ ...fb, content: { blanks: 2 }, answer_key: { blanks: [{ accepted: ['is'] }, { accepted: ['was'] }] } })).toBe(true);
    expect(ok({ ...fb, content: { blanks: 1 }, answer_key: { blanks: [{ accepted: ['is'] }] } })).toBe(false);
    expect(ok({ ...fb, content: { blanks: 2 }, answer_key: { blanks: [{ accepted: ['is'] }] } })).toBe(false);
  });

  it('matching: every left item needs a valid match', () => {
    const content = { left: [{ id: 'l1', text: 'Cat' }, { id: 'l2', text: 'Dog' }], right: [{ id: 'r1', text: 'Meow' }, { id: 'r2', text: 'Woof' }] };
    expect(ok({ question_type: 'matching', content, answer_key: { pairs: { l1: 'r1', l2: 'r2' } } })).toBe(true);
    expect(ok({ question_type: 'matching', content, answer_key: { pairs: { l1: 'r1' } } })).toBe(false);
    expect(ok({ question_type: 'matching', content, answer_key: { pairs: { l1: 'r1', l2: 'r9' } } })).toBe(false);
  });

  it('ordering: the order must be a permutation of the items', () => {
    const content = { items: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }, { id: 'c', text: 'Third' }] };
    expect(ok({ question_type: 'ordering', content, answer_key: { order: ['a', 'b', 'c'] } })).toBe(true);
    expect(ok({ question_type: 'ordering', content, answer_key: { order: ['a', 'b', 'b'] } })).toBe(false);
  });

  it('translation requires language codes; code requires a language', () => {
    const t = { question_type: 'translation' as const, grading_method: 'manual' as const, answer_key: {} };
    expect(ok({ ...t, content: { source_language: 'ur', target_language: 'en', source_text: 'میں سیکھ رہی ہوں' } })).toBe(true);
    expect(ok({ ...t, content: { source_language: 'Urdu', target_language: 'en' } })).toBe(false);
    expect(ok({ question_type: 'code', grading_method: 'manual', content: {}, answer_key: {} })).toBe(false);
    expect(ok({ question_type: 'code', grading_method: 'manual', content: { language: 'python' }, answer_key: {} })).toBe(true);
  });

  it('rejects zero marks and negative marks above marks', () => {
    expect(ok({ marks: 0 })).toBe(false);
    expect(ok({ marks: 1, negative_marks: 2 })).toBe(false);
    expect(ok({ marks: 1.555 })).toBe(false);
  });
});

describe('test settings validation', () => {
  const settings = { title: 'Algebra basics', subject_id: '6f1c4e9a-0a7b-4c55-9c3e-2a1d8f0b7e11', duration_minutes: 30 };

  it('applies defaults and accepts custom difficulty labels and any language', () => {
    const r = saveTestSchema.parse({ settings: { ...settings, difficulty: 'Grade 7', language: 'fr-CA' } });
    expect(r.settings).toMatchObject({ difficulty: 'Grade 7', language: 'fr-CA', passing_percentage: 50 });
    expect(r.questions).toBeNull();
  });

  it('validates duration, pass mark and identity fields', () => {
    expect(saveTestSchema.safeParse({ settings: { ...settings, duration_minutes: 0 } }).success).toBe(false);
    expect(saveTestSchema.safeParse({ settings: { ...settings, passing_percentage: 120 } }).success).toBe(false);
    expect(
      saveTestSchema.safeParse({ settings: { ...settings, identity_fields: [{ key: 'name', label: 'Name' }] } }).success,
    ).toBe(false);
    expect(
      saveTestSchema.safeParse({ settings: { ...settings, identity_fields: [{ key: 'roll_no', label: 'Roll number', required: true }] } })
        .success,
    ).toBe(true);
  });

  it('preserves question order', () => {
    const r = saveTestSchema.parse({ settings, questions: [base({ prompt: 'First' }), base({ prompt: 'Second' })] });
    expect(r.questions!.map((q) => q.prompt)).toEqual(['First', 'Second']);
  });
});
