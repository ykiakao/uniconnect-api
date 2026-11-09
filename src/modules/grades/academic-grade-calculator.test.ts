import {
  AssessmentItem,
  AssessmentScore,
  AssessmentStage,
  calculateAcademicGrade,
} from './academic-grade-calculator';

const closed = Object.freeze({ N1: true, N2: true });
const missing = { publication: 'missing' } as const;

function published(value: string | null): AssessmentScore {
  return { publication: 'published', value };
}

function exam(stage: AssessmentStage, id: string, directPoints: AssessmentScore, maxPoints = '7.00'): AssessmentItem {
  return { stage, id, category: 'exam', maxPoints, directPoints };
}

function activity(stage: AssessmentStage, id: string, originalGrade: AssessmentScore, maxPoints = '1.50'): AssessmentItem {
  return { stage, id, category: 'activity', maxPoints, originalGrade };
}

describe('calculateAcademicGrade', () => {
  it('combines exams and weighted activities in each stage and calculates the semester average', () => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published('5.50')),
      activity('N1', 'a1', published('8.00')),
      exam('N2', 'e2', published('6.75')),
      activity('N2', 'a2', published('9.00'), '2.00'),
    ], closed);

    expect(result).toMatchObject({
      stages: {
        N1: {
          status: 'definitive', examPoints: '5.50', activityPoints: '1.20', total: '6.70',
          publishedItems: [
            { id: 'e1', category: 'exam', directPoints: '5.50', points: '5.50' },
            { id: 'a1', category: 'activity', originalGrade: '8.00', points: '1.20' },
          ],
        },
        N2: { status: 'definitive', examPoints: '6.75', activityPoints: '1.80', total: '8.55' },
      },
      average: '7.625',
      status: 'approved',
    });
  });

  it.each([
    ['4.99', 'below_minimum'],
    ['5.00', 'final_exam_eligible'],
    ['6.99', 'final_exam_eligible'],
    ['7.00', 'approved'],
  ])('classifies the exact average %s as %s', (points, status) => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published(points)),
      exam('N2', 'e2', published(points)),
    ], closed);

    expect(result).toMatchObject({ average: points, status });
  });

  it.each([
    ['4.99', '5.00', '4.999995', 'below_minimum'],
    ['6.99', '7.00', '6.999995', 'final_exam_eligible'],
  ])('retains full precision near the cutoff %s / %s', (examPoints, otherStage, average, status) => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published(examPoints)),
      activity('N1', 'a1', published('9.99'), '0.01'),
      exam('N2', 'e2', published(otherStage)),
    ], closed);

    expect(result.stages.N1.activityPoints).toBe('0.00999');
    expect(result).toMatchObject({ average, status });
  });

  it('preserves published zero and leaves an unused category unavailable', () => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published('0')),
      activity('N2', 'a2', published('0.00')),
    ], closed);

    expect(result).toMatchObject({
      stages: {
        N1: { status: 'definitive', examPoints: '0.00', activityPoints: null, total: '0.00', pendingItemIds: [] },
        N2: { status: 'definitive', examPoints: null, activityPoints: '0.00', total: '0.00', pendingItemIds: [] },
      },
      average: '0.00',
      status: 'below_minimum',
    });
    expect(result.stages.N1.publishedItems[0]).toMatchObject({ directPoints: '0' });
  });

  it('treats missing, draft and published without a numeric value identically for the student', () => {
    const pending = calculateAcademicGrade([exam('N1', 'e1', missing)], closed);
    expect(pending).toMatchObject({
      stages: {
        N1: { status: 'pending', total: null, pendingItemIds: ['e1'], publishedItems: [] },
        N2: { status: 'pending', total: null, pendingItemIds: [], publishedItems: [] },
      },
      average: null,
      status: 'pending',
    });
    expect(calculateAcademicGrade([exam('N1', 'e1', { publication: 'draft', value: '5.73' })], closed)).toEqual(pending);
    expect(calculateAcademicGrade([exam('N1', 'e1', published(null))], closed)).toEqual(pending);
  });

  it('returns partial totals and average when a closed stage has a pending item', () => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published('6.00')),
      activity('N1', 'a1', missing),
      exam('N2', 'e2', published('7.00')),
      activity('N2', 'a2', published('10.00')),
    ], closed);

    expect(result).toMatchObject({
      stages: {
        N1: { status: 'partial', total: '6.00', pendingItemIds: ['a1'] },
        N2: { status: 'definitive', total: '8.50' },
      },
      average: '7.25',
      status: 'partial',
    });
  });

  it('waits for N2 to close even when both stages have every grade', () => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published('7.00')),
      exam('N2', 'e2', published('7.00')),
    ], { N1: true, N2: false });

    expect(result).toMatchObject({
      stages: { N1: { status: 'definitive' }, N2: { status: 'partial', pendingItemIds: [] } },
      average: '7.00',
      status: 'partial',
    });
  });

  it('leaves the semester average unavailable until both stages have a numeric result', () => {
    const result = calculateAcademicGrade([exam('N1', 'e1', published('7.00'))], closed);
    expect(result).toMatchObject({ average: null, status: 'partial' });
  });

  it('allows the exact allocation limits across multiple items', () => {
    const result = calculateAcademicGrade([
      exam('N1', 'e1', published('3.51'), '3.51'),
      exam('N1', 'e2', published('3.49'), '3.49'),
      activity('N1', 'a1', published('10.00'), '1.01'),
      activity('N1', 'a2', published('10.00'), '1.99'),
    ], closed);

    expect(result.stages.N1).toMatchObject({ examPoints: '7.00', activityPoints: '3.00', total: '10.00' });
  });

  it.each([
    [exam('N1', 'e1', missing, '3.00'), exam('N1', 'e2', missing, '4.01')],
    [activity('N2', 'a1', missing, '1.49'), activity('N2', 'a2', missing, '1.52')],
  ])('rejects a category allocation over its stage limit', (first, second) => {
    expect(() => calculateAcademicGrade([first, second], closed)).toThrow(/allocation exceeds/);
  });

  it.each([
    exam('N1', 'e1', published('5.51'), '5.50'),
    activity('N1', 'a1', published('10.01')),
    exam('N2', 'e2', { publication: 'draft', value: '7.01' }),
  ])('rejects a score above its maximum', item => {
    expect(() => calculateAcademicGrade([item], closed)).toThrow(/Score exceeds/);
  });

  it.each(['-0.01', '1.001', '1e-2', 'NaN', 'Infinity', '1,25', ''])('rejects invalid decimal %j', value => {
    expect(() => calculateAcademicGrade([exam('N1', 'e1', published(value))], closed)).toThrow(RangeError);
    expect(() => calculateAcademicGrade([activity('N1', 'a1', missing, value)], closed)).toThrow(RangeError);
  });

  it('rejects duplicate IDs across stages and categories', () => {
    expect(() => calculateAcademicGrade([
      exam('N1', 'same', published('4.00')),
      activity('N2', 'same', published('9.00')),
    ], closed)).toThrow(/unique/);
  });

  it('calculates deterministically without mutating frozen inputs', () => {
    const grade = Object.freeze(published('7.25'));
    const items = Object.freeze([Object.freeze(activity('N1', 'a1', grade))]);
    const first = calculateAcademicGrade(items, closed);

    expect(first.stages.N1.activityPoints).toBe('1.0875');
    expect(calculateAcademicGrade(items, closed)).toEqual(first);
    expect(items).toEqual([activity('N1', 'a1', published('7.25'))]);
  });
});
