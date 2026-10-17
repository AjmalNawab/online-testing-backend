import { QUESTION_TYPE_LABELS, type QuestionType } from '../contracts/constants.js';
import type { ProgressReport } from '../contracts/responses.js';
import { percentageOf, round2 } from '../grading/grade.js';

export interface ProgressAttempt {
  id: string;
  submitted_at: string;
  test_title: string;
  subject: string;
  topic: string | null;
  percentage: number;
}

export interface ProgressAnswer {
  question_type: QuestionType;
  awarded: number;
  marks: number;
}

const avg = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Builds the progress report and recommendations strictly from stored, fully graded results. */
export function buildProgress(
  students: string[],
  student: string | null,
  attempts: ProgressAttempt[],
  answers: ProgressAnswer[],
): ProgressReport {
  const sorted = [...attempts].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
  const percentages = sorted.map((a) => a.percentage);

  const group = <K extends string>(key: (a: ProgressAttempt) => K | null) => {
    const map = new Map<K, number[]>();
    for (const a of sorted) {
      const k = key(a);
      if (k === null) continue;
      map.set(k, [...(map.get(k) ?? []), a.percentage]);
    }
    return map;
  };

  const bySubject = [...group((a) => a.subject).entries()].map(([subject, ps]) => ({
    subject,
    attempts: ps.length,
    average_percentage: avg(ps)!,
  }));

  const byTopic = [...group((a) => (a.topic ? `${a.subject}\u0000${a.topic}` : null)).entries()].map(([key, ps]) => {
    const [subject, topic] = key.split('\u0000') as [string, string];
    return { subject, topic, attempts: ps.length, average_percentage: avg(ps)! };
  });

  const typeTotals = new Map<QuestionType, { earned: number; possible: number }>();
  for (const a of answers) {
    const t = typeTotals.get(a.question_type) ?? { earned: 0, possible: 0 };
    t.earned += Math.max(0, a.awarded);
    t.possible += a.marks;
    typeTotals.set(a.question_type, t);
  }
  const byType = [...typeTotals.entries()].map(([question_type, t]) => ({
    question_type,
    earned: round2(t.earned),
    possible: round2(t.possible),
    percentage: percentageOf(t.earned, t.possible),
  }));

  return {
    students,
    student,
    totals: {
      attempts: sorted.length,
      average_percentage: avg(percentages),
      best_percentage: percentages.length ? Math.max(...percentages) : null,
      latest_percentage: percentages.length ? percentages[percentages.length - 1]! : null,
    },
    timeline: sorted.map((a) => ({
      date: a.submitted_at,
      test: a.test_title,
      subject: a.subject,
      percentage: a.percentage,
    })),
    by_subject: bySubject,
    by_topic: byTopic,
    by_question_type: byType,
    recommendations: recommend(byTopic, bySubject, byType, percentages),
  };
}

function recommend(
  byTopic: { subject: string; topic: string; attempts: number; average_percentage: number }[],
  bySubject: { subject: string; average_percentage: number }[],
  byType: { question_type: QuestionType; possible: number; percentage: number }[],
  percentages: number[],
): string[] {
  const out: string[] = [];
  const areas = byTopic.length >= 2
    ? byTopic.map((t) => ({ name: t.topic, pct: t.average_percentage }))
    : bySubject.map((s) => ({ name: s.subject, pct: s.average_percentage }));
  const ranked = [...areas].sort((a, b) => a.pct - b.pct);
  const weakest = ranked[0];
  const strongest = ranked[ranked.length - 1];

  if (weakest && strongest && ranked.length >= 2 && strongest.pct - weakest.pct >= 10) {
    out.push(
      `Your score in ${strongest.name} is ${Math.round(strongest.pct)}%, but your score in ${weakest.name} is ${Math.round(weakest.pct)}%. Practise ${weakest.name} before taking the next test.`,
    );
  }
  for (const area of ranked.filter((a) => a.pct < 60 && a !== weakest).slice(0, 2)) {
    out.push(`${area.name} needs more practice (${Math.round(area.pct)}% average).`);
  }
  if (weakest && ranked.length === 1 && weakest.pct < 60) {
    out.push(`Your average in ${weakest.name} is ${Math.round(weakest.pct)}%. Revise it and try another test.`);
  }

  const weakType = [...byType].filter((t) => t.possible >= 3 && t.percentage < 60).sort((a, b) => a.percentage - b.percentage)[0];
  if (weakType) {
    out.push(`${QUESTION_TYPE_LABELS[weakType.question_type]} questions are the weakest type so far (${Math.round(weakType.percentage)}%).`);
  }

  if (percentages.length >= 3) {
    const recent = avg(percentages.slice(-3))!;
    const earlier = avg(percentages.slice(0, -3).length ? percentages.slice(0, -3) : percentages.slice(0, 1))!;
    if (recent - earlier >= 10) out.push(`Great progress: your recent average is ${Math.round(recent)}%, up from ${Math.round(earlier)}%.`);
    else if (earlier - recent >= 10) out.push(`Recent scores have dropped to ${Math.round(recent)}% from ${Math.round(earlier)}%. A short revision session may help.`);
  }
  return out;
}
