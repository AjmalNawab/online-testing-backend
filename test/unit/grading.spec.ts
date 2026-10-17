import { randomUUID } from 'node:crypto';
import { gradeAttempt, gradeQuestion, percentageOf, type GradableQuestion } from '../../src/grading/grade.js';
import { evaluators, isAnswered } from '../../src/grading/evaluators.js';
import { normalizeAnswerText, textAnswerMatches } from '../../src/grading/normalize.js';

const policy = { negativeMarking: false, partialCredit: true };
const opts = (ids: string[]) => ids.map((id) => ({ id, text: id.toUpperCase() }));

const q = (overrides: Partial<GradableQuestion>): GradableQuestion => ({
  id: randomUUID(),
  question_type: 'mcq_single',
  content: { options: opts(['a', 'b', 'c', 'd']) },
  answer_key: { correct: 'b' },
  marks: 2,
  negative_marks: 0.5,
  partial_credit: null,
  ...overrides,
});

describe('normalizeAnswerText', () => {
  it('ignores case, whitespace, trailing punctuation and wrapping quotes', () => {
    expect(normalizeAnswerText('  Is.  ')).toBe('is');
    expect(normalizeAnswerText('"IS"')).toBe('is');
    expect(normalizeAnswerText('an   apple!')).toBe('an apple');
  });
  it('normalises typographic apostrophes', () => {
    expect(textAnswerMatches('Don’t', ["don't"])).toBe(true);
  });
  it('keeps genuinely different answers different', () => {
    expect(textAnswerMatches('are', ['is'])).toBe(false);
    expect(textAnswerMatches('its', ["it's"])).toBe(false);
    expect(textAnswerMatches('3.14', ['3.15'])).toBe(false);
    expect(textAnswerMatches('', ['is'])).toBe(false);
  });
  it('honours case sensitivity', () => {
    expect(textAnswerMatches('paris', ['Paris'], true)).toBe(false);
    expect(textAnswerMatches('Paris.', ['Paris'], true)).toBe(true);
  });
});

describe('isAnswered', () => {
  it('detects empty answers of every shape', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered('  ')).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(['', ' '])).toBe(false);
    expect(isAnswered({})).toBe(false);
    expect(isAnswered(false)).toBe(true);
    expect(isAnswered({ a: '1' })).toBe(true);
  });
});

describe('gradeQuestion', () => {
  it('MCQ: full, zero, unanswered', () => {
    expect(gradeQuestion(q({}), 'b', policy)).toMatchObject({ outcome: 'correct', awarded_marks: 2, is_correct: true });
    expect(gradeQuestion(q({}), 'a', policy)).toMatchObject({ outcome: 'incorrect', awarded_marks: 0 });
    expect(gradeQuestion(q({}), null, policy)).toMatchObject({ outcome: 'unanswered', awarded_marks: 0 });
  });

  it('negative marking applies only when enabled, never to unanswered', () => {
    const neg = { ...policy, negativeMarking: true };
    expect(gradeQuestion(q({}), 'a', neg).awarded_marks).toBe(-0.5);
    expect(gradeQuestion(q({}), null, neg).awarded_marks).toBe(0);
  });

  it('True/False rejects wrongly-typed answers', () => {
    const tf = q({ question_type: 'true_false', content: {}, answer_key: { correct: true } });
    expect(gradeQuestion(tf, true, policy).outcome).toBe('correct');
    expect(gradeQuestion(tf, 'true', policy).outcome).toBe('incorrect');
  });

  it('multiple select: exact, partial, wrong picks deduct, floor at 0', () => {
    const mm = q({ question_type: 'mcq_multiple', answer_key: { correct: ['a', 'c'] }, marks: 4 });
    expect(gradeQuestion(mm, ['c', 'a'], policy)).toMatchObject({ outcome: 'correct', awarded_marks: 4 });
    expect(gradeQuestion(mm, ['a'], policy)).toMatchObject({ outcome: 'partial', awarded_marks: 2 });
    expect(gradeQuestion(mm, ['a', 'b'], policy)).toMatchObject({ outcome: 'incorrect', awarded_marks: 0 });
    expect(gradeQuestion(mm, ['a', 'c', 'd'], policy)).toMatchObject({ outcome: 'partial', awarded_marks: 2 });
    expect(gradeQuestion(mm, ['a', 'zz'], policy).awarded_marks).toBe(2); // unknown ids ignored
  });

  it('question-level partial_credit overrides the test default', () => {
    const mm = q({ question_type: 'mcq_multiple', answer_key: { correct: ['a', 'c'] }, marks: 4, partial_credit: false });
    expect(gradeQuestion(mm, ['a'], policy).awarded_marks).toBe(0);
    const mm2 = { ...mm, partial_credit: true };
    expect(gradeQuestion(mm2, ['a'], { ...policy, partialCredit: false }).awarded_marks).toBe(2);
  });

  it('fill in the blanks: per-blank partial credit with accepted alternatives', () => {
    const fb = q({
      question_type: 'fill_blank',
      content: { blanks: 2 },
      answer_key: { blanks: [{ accepted: ['is', 'was'] }, { accepted: ['happy'] }], case_sensitive: false },
      marks: 4,
    });
    expect(gradeQuestion(fb, ['Was', 'happy.'], policy).outcome).toBe('correct');
    expect(gradeQuestion(fb, ['is', 'sad'], policy)).toMatchObject({ outcome: 'partial', awarded_marks: 2 });
    expect(gradeQuestion(fb, ['is', 'sad'], { ...policy, partialCredit: false }).awarded_marks).toBe(0);
  });

  it('matching: fraction of correct pairs', () => {
    const m = q({
      question_type: 'matching',
      content: { left: opts(['l1', 'l2', 'l3', 'l4']), right: opts(['r1', 'r2', 'r3', 'r4', 'r5']) },
      answer_key: { pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' } },
      marks: 4,
    });
    expect(gradeQuestion(m, { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' }, policy).outcome).toBe('correct');
    expect(gradeQuestion(m, { l1: 'r1', l2: 'r3', l3: 'r2' }, policy)).toMatchObject({ outcome: 'partial', awarded_marks: 1 });
  });

  it('ordering: fraction of items in the correct position', () => {
    const o = q({
      question_type: 'ordering',
      content: { items: opts(['a', 'b', 'c', 'd']) },
      answer_key: { order: ['a', 'b', 'c', 'd'] },
      marks: 4,
    });
    expect(gradeQuestion(o, ['a', 'b', 'c', 'd'], policy).outcome).toBe('correct');
    expect(gradeQuestion(o, ['a', 'b', 'd', 'c'], policy).awarded_marks).toBe(2);
    expect(gradeQuestion(o, ['d', 'c', 'b', 'a'], policy).awarded_marks).toBe(0);
  });

  it('written answers wait for review unless blank', () => {
    for (const type of ['short_answer', 'long_answer', 'sentence_construction', 'translation', 'code'] as const) {
      const w = q({ question_type: type, content: {}, answer_key: {} });
      expect(gradeQuestion(w, 'Some answer', policy)).toMatchObject({ outcome: 'pending_review', awarded_marks: null });
      expect(gradeQuestion(w, '   ', policy)).toMatchObject({ outcome: 'unanswered', awarded_marks: 0 });
    }
  });
});

describe('student content projection', () => {
  it('ordering items are never shown in the correct order and are stable per seed', () => {
    const content = { items: opts(['a', 'b', 'c']) };
    const shown = evaluators.ordering.toStudentContent(content, 'attempt-1:q1', false).items as { id: string }[];
    expect(shown.map((i) => i.id)).not.toEqual(['a', 'b', 'c']);
    const again = evaluators.ordering.toStudentContent(content, 'attempt-1:q1', false).items as { id: string }[];
    expect(again).toEqual(shown);
  });

  it('MCQ options keep their order unless shuffling is enabled', () => {
    const content = { options: opts(['a', 'b', 'c', 'd', 'e', 'f']) };
    expect(evaluators.mcq_single.toStudentContent(content, 's', false)).toEqual(content);
    const shuffled = evaluators.mcq_single.toStudentContent(content, 's', true).options as { id: string }[];
    expect(shuffled.map((o) => o.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('gradeAttempt', () => {
  const mcq = q({ marks: 2 });
  const tf = q({ question_type: 'true_false', content: {}, answer_key: { correct: false }, marks: 1 });
  const essay = q({ question_type: 'long_answer', content: {}, answer_key: {}, marks: 7 });

  it('stays pending while written answers await review', () => {
    const { summary } = gradeAttempt(
      [mcq, tf, essay],
      [
        { question_id: mcq.id, answer: 'b', awarded_marks: null, grading_status: 'ungraded' },
        { question_id: tf.id, answer: true, awarded_marks: null, grading_status: 'ungraded' },
        { question_id: essay.id, answer: 'An essay', awarded_marks: null, grading_status: 'ungraded' },
      ],
      policy,
      50,
    );
    expect(summary).toMatchObject({
      objective_score: 2,
      final_score: null,
      percentage: null,
      passed: null,
      maximum_marks: 10,
      correct_count: 1,
      incorrect_count: 1,
      pending_review_count: 1,
      grading_status: 'pending_review',
    });
  });

  it('uses reviewed marks and completes', () => {
    const { summary, grades } = gradeAttempt(
      [mcq, tf, essay],
      [
        { question_id: mcq.id, answer: 'b', awarded_marks: 2, grading_status: 'auto_graded' },
        { question_id: essay.id, answer: 'An essay', awarded_marks: 5, grading_status: 'reviewed' },
      ],
      policy,
      70,
    );
    expect(grades.map((g) => g.question_id)).not.toContain(essay.id);
    expect(summary).toMatchObject({ final_score: 7, percentage: 70, passed: true, unanswered_count: 1, grading_status: 'complete' });
  });

  it('never reports a negative total', () => {
    const { summary } = gradeAttempt(
      [mcq],
      [{ question_id: mcq.id, answer: 'a', awarded_marks: null, grading_status: 'ungraded' }],
      { negativeMarking: true, partialCredit: true },
      50,
    );
    expect(summary.final_score).toBe(0);
  });
});

describe('percentageOf', () => {
  it('(obtained / maximum) × 100, two decimals, safe for zero', () => {
    expect(percentageOf(17, 20)).toBe(85);
    expect(percentageOf(1, 3)).toBe(33.33);
    expect(percentageOf(0, 0)).toBe(0);
  });
});
