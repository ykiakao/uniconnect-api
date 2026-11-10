export type AssessmentStage = 'N1' | 'N2';
export type AssessmentCategory = 'exam' | 'activity';

// Input uses decimal strings with up to two fractional digits and a decimal point.
export type AssessmentScore =
  | { publication: 'missing'; value?: never }
  | { publication: 'draft' | 'published'; value: string | null };

type AssessmentItemBase = { id: string; stage: AssessmentStage; maxPoints: string };

export type AssessmentItem = AssessmentItemBase & (
  | { category: 'exam'; directPoints: AssessmentScore }
  | { category: 'activity'; originalGrade: AssessmentScore }
);

export type StageClosure = Readonly<Record<AssessmentStage, boolean>>;

type PublishedAssessment = { id: string; points: string } & (
  | { category: 'exam'; directPoints: string }
  | { category: 'activity'; originalGrade: string }
);

export type StageResult = {
  status: 'pending' | 'partial' | 'definitive';
  examPoints: string | null;
  activityPoints: string | null;
  total: string | null;
  publishedItems: PublishedAssessment[];
  pendingItemIds: string[];
};

export type AcademicGradeResult = {
  stages: Record<AssessmentStage, StageResult>;
  average: string | null;
  status: 'pending' | 'partial' | 'approved' | 'final_exam_eligible' | 'below_minimum';
};

const maxCents = { exam: 700, activity: 300 };

// A weighted activity can produce five fractional digits. A semester average
// can produce six. All calculations and cutoffs use exact, bounded integers.
function parseCents(value: string, max: number, field: string): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new RangeError(`${field} must be a non-negative decimal with up to two fractional digits`);
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents > max) {
    throw new RangeError(`${field} exceeds its maximum`);
  }
  return cents;
}

// Output keeps at least two fractional digits and retains all significant digits.
function decimal(units: number, places: 5 | 6): string {
  const scale = 10 ** places;
  const fraction = String(units % scale).padStart(places, '0').replace(/0+$/, '');
  return `${Math.floor(units / scale)}.${fraction.padEnd(2, '0')}`;
}

function emptyStage() {
  return {
    allocatedCents: { exam: 0, activity: 0 },
    points: { exam: null, activity: null } as Record<AssessmentCategory, number | null>,
    publishedItems: [] as PublishedAssessment[],
    pendingItemIds: [] as string[],
  };
}

function summarizeStage(stage: ReturnType<typeof emptyStage>, closed: boolean) {
  const { points, publishedItems, pendingItemIds } = stage;
  const total = publishedItems.length ? (points.exam ?? 0) + (points.activity ?? 0) : null;
  const result: StageResult = {
    status: total === null ? 'pending' : closed && !pendingItemIds.length ? 'definitive' : 'partial',
    examPoints: points.exam === null ? null : decimal(points.exam, 5),
    activityPoints: points.activity === null ? null : decimal(points.activity, 5),
    total: total === null ? null : decimal(total, 5),
    publishedItems,
    pendingItemIds,
  };
  return { result, total };
}

/** Every supplied item is required. Supply only student-visible items to this projection. */
export function calculateAcademicGrade(
  items: readonly AssessmentItem[],
  closed: StageClosure,
): AcademicGradeResult {
  if (typeof closed.N1 !== 'boolean' || typeof closed.N2 !== 'boolean') {
    throw new RangeError('Both stage closures must be specified');
  }

  const stages = { N1: emptyStage(), N2: emptyStage() };
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || seen.has(item.id)) {
      throw new RangeError('Assessment IDs must be non-empty, trimmed and unique');
    }
    seen.add(item.id);
    if (item.stage !== 'N1' && item.stage !== 'N2') {
      throw new RangeError('Invalid assessment stage');
    }
    const { category } = item;
    if (category !== 'exam' && category !== 'activity') {
      throw new RangeError('Invalid assessment category');
    }

    const stage = stages[item.stage];
    const maximum = parseCents(item.maxPoints, maxCents[category], 'Item maximum');
    stage.allocatedCents[category] += maximum;
    if (stage.allocatedCents[category] > maxCents[category]) {
      throw new RangeError(`${item.stage} ${category} allocation exceeds its maximum`);
    }

    const score = item.category === 'exam' ? item.directPoints : item.originalGrade;
    if (score.publication === 'missing') {
      if (score.value !== undefined) throw new RangeError('Missing score cannot carry a value');
      stage.pendingItemIds.push(item.id);
      continue;
    }
    if (score.publication !== 'draft' && score.publication !== 'published') {
      throw new RangeError('Invalid score publication state');
    }
    const { value } = score;
    const numericScore = value === null ? null : {
      value,
      cents: parseCents(value, category === 'exam' ? maximum : 1000, 'Score'),
    };
    if (score.publication === 'draft' || numericScore === null) {
      stage.pendingItemIds.push(item.id);
      continue;
    }

    const units = category === 'exam' ? numericScore.cents * 1000 : numericScore.cents * maximum;
    stage.points[category] = (stage.points[category] ?? 0) + units;
    const points = decimal(units, 5);
    stage.publishedItems.push(category === 'exam'
      ? { id: item.id, category, directPoints: numericScore.value, points }
      : { id: item.id, category, originalGrade: numericScore.value, points });
  }

  const n1 = summarizeStage(stages.N1, closed.N1);
  const n2 = summarizeStage(stages.N2, closed.N2);
  const summary = { N1: n1.result, N2: n2.result };
  if (n1.total === null || n2.total === null) {
    const status = n1.total === null && n2.total === null ? 'pending' : 'partial';
    return { stages: summary, average: null, status };
  }

  // Convert the sum from 10^-5 to 10^-6 units and divide by two in one step.
  const averageUnits = (n1.total + n2.total) * 5;
  const average = decimal(averageUnits, 6);
  if (n1.result.status !== 'definitive' || n2.result.status !== 'definitive') {
    return { stages: summary, average, status: 'partial' };
  }
  if (averageUnits >= 7_000_000) return { stages: summary, average, status: 'approved' };
  if (averageUnits >= 5_000_000) return { stages: summary, average, status: 'final_exam_eligible' };
  return { stages: summary, average, status: 'below_minimum' };
}
