import { createSupabaseAdminClient } from '../../../config/supabase';
import { ActivitiesRepository } from '../../activities/activities.repository';
import { HttpError } from '../../../shared/http-error';
import { AcademicStructureRepository } from '../../academic-structure/academic-structure.repository';
import { GradesRepository } from '../../grades/grades.repository';
import { UsersRepository } from '../../users/users.repository';
import { AcademicHistorySchema, AcademicOverviewSchema, AcademicPeriodsSchema } from '../academic.contracts';
import { NativeAcademicProvider } from './native-academic.provider';

const tenantId = 'native-synthetic-tenant';
const context = { userId: 'native-student', tenant: { id: tenantId, slug: 'synthetic-native', name: 'Instituicao Sintetica' } };
const db = createSupabaseAdminClient();
const tables = ['grades', 'activities', 'enrollments', 'teaching_assignments', 'classes', 'subjects', 'academic_periods', 'app_users'];

async function offering(id: string, period = 'period-current', status = 'active', student = context.userId) {
  await db.from('subjects').insert({ id: `subject-${id}`, tenant_id: tenantId, course_id: 'synthetic-course', code: id, name: `Disciplina ${id}`, status: 'active' });
  await db.from('classes').insert({ id, tenant_id: tenantId, course_id: 'synthetic-course', subject_id: `subject-${id}`, academic_period_id: period, name: `Turma ${id}`, academic_status: 'active' });
  await db.from('enrollments').insert({ id: `enrollment-${id}`, tenant_id: tenantId, class_id: id, student_id: student, status });
}

beforeEach(async () => {
  jest.restoreAllMocks();
  for (const table of tables) await db.from(table).delete().eq('tenant_id', tenantId);
  await db.from('app_users').insert([
    { id: context.userId, tenant_id: tenantId, auth_user_id: 'native-student-auth', name: 'Aluno Sintetico', email: 'native-student@example.invalid', role: 'student', active: true },
    { id: 'native-teacher', tenant_id: tenantId, auth_user_id: 'native-teacher-auth', name: 'Docente Sintetico', email: 'native-teacher@example.invalid', role: 'teacher', active: true },
  ]);
  await db.from('academic_periods').insert([
    { id: 'period-current', tenant_id: tenantId, code: '2026.2', name: 'Periodo atual sintetico', status: 'active' },
    { id: 'period-past', tenant_id: tenantId, code: '2026.1', name: 'Periodo passado sintetico', status: 'closed' },
    { id: 'period-future', tenant_id: tenantId, code: '2027.1', name: 'Periodo futuro sintetico', status: 'planned' },
  ]);
});

afterEach(() => jest.restoreAllMocks());

describe('NativeAcademicProvider', () => {
  it('lists persisted tenant periods and prefers the active period over a future code', async () => {
    const provider = new NativeAcademicProvider(context);
    const result = AcademicPeriodsSchema.parse(await provider.getPeriods());
    expect(result.source).toEqual({ providerId: 'native', demonstration: false, label: 'Dados acadêmicos institucionais do UniConnect' });
    expect(result.periods.map(period => period.id)).toEqual(['period-future', 'period-current', 'period-past']);
    expect((await provider.getOverview()).period.id).toBe('period-current');
    expect((await provider.getOverview({ periodId: 'period-past' })).period.id).toBe('period-past');
    await expect(provider.getOverview({ periodId: 'absent' })).rejects.toMatchObject({ code: 'ACADEMIC_PERIOD_NOT_FOUND' });
    await provider.close();
  });

  it('returns multiple own enrollments and preserves individual grade, feedback, zero and absence', async () => {
    await offering('class-a'); await offering('class-b'); await offering('other-student-class', 'period-current', 'active', 'someone-else');
    await db.from('activities').insert([
      { id: 'activity-zero', tenant_id: tenantId, class_id: 'class-a', title: 'Avaliacao zero', type: 'assignment', due_date: '2026-11-15', description: 'Descricao sintetica' },
      { id: 'activity-ungraded', tenant_id: tenantId, class_id: 'class-a', title: 'Sem nota', type: 'assignment' },
      { id: 'activity-null', tenant_id: tenantId, class_id: 'class-b', title: 'Nota nula', type: 'assignment' },
    ]);
    await db.from('grades').insert([
      { tenant_id: tenantId, activity_id: 'activity-zero', student_id: 'native-student-auth', grade: 0, feedback: 'Revisar exercicio', graded_at: '2026-10-25T12:00:00Z' },
      { tenant_id: tenantId, activity_id: 'activity-null', student_id: 'native-student-auth', grade: null, feedback: 'Em correcao', graded_at: null },
      { tenant_id: tenantId, activity_id: 'activity-ungraded', student_id: 'different-auth', grade: 10, feedback: 'Privado' },
    ]);
    const result = AcademicOverviewSchema.parse(await new NativeAcademicProvider(context).getOverview());
    expect(result.subjects).toHaveLength(2);
    const a = result.subjects.find(subject => subject.classId === 'class-a')!;
    expect(a).toMatchObject({ id: 'subject-class-a', offeringId: 'class-a', enrollmentSubjectId: 'enrollment-class-a', periodId: 'period-current', status: 'in_progress', grades: null, attendance: { absences: null, absencePercentage: null } });
    expect(a.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: 'activity-zero', title: 'Avaliacao zero', grade: 0, feedback: 'Revisar exercicio', gradedAt: '2026-10-25T12:00:00Z' }),
      expect.objectContaining({ activityId: 'activity-ungraded', grade: null }),
    ]));
    expect(result.subjects.find(subject => subject.classId === 'class-b')?.assessments?.[0]).toMatchObject({ grade: null, feedback: 'Em correcao', gradedAt: null });
    expect(JSON.stringify(result)).not.toContain('Privado');
    expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining(['ATTENDANCE_UNAVAILABLE', 'AGGREGATES_UNAVAILABLE']));
  });

  it('reads a new persisted grade on every request without caching', async () => {
    await offering('class-a');
    await db.from('activities').insert({ id: 'changing-grade', tenant_id: tenantId, class_id: 'class-a', title: 'Alteravel', type: 'assignment' });
    const provider = new NativeAcademicProvider(context);
    expect((await provider.getOverview()).subjects[0].assessments?.[0].grade).toBeNull();
    await new GradesRepository().upsert({ tenantId, activityId: 'changing-grade', studentId: context.userId, grade: 9, feedback: 'Atualizado', gradedBy: 'native-teacher-auth' });
    expect((await provider.getOverview()).subjects[0].assessments?.[0]).toMatchObject({ grade: 9, feedback: 'Atualizado' });
  });

  it('keeps completed, cancelled and suspended records in history without calling them passed', async () => {
    await offering('completed', 'period-past', 'completed');
    await offering('cancelled', 'period-past', 'cancelled');
    await offering('suspended', 'period-current', 'suspended');
    const result = AcademicHistorySchema.parse(await new NativeAcademicProvider(context).getHistory());
    const subjects = result.periods.flatMap(period => period.subjects);
    expect(subjects.map(subject => subject.status).sort()).toEqual(['cancelled', 'completed', 'suspended']);
    expect(result.complete).toBe(false);
  });

  it('returns no other student data when the current student has no enrollments', async () => {
    await offering('other-class', 'period-current', 'active', 'someone-else');
    const result = await new NativeAcademicProvider(context).getOverview();
    expect(result.subjects).toEqual([]); expect(result.complete).toBe(true);
  });

  it('does not manufacture a period when none is persisted', async () => {
    await db.from('academic_periods').delete().eq('tenant_id', tenantId);
    const provider = new NativeAcademicProvider(context);
    expect((await provider.getPeriods()).periods).toEqual([]);
    await expect(provider.getOverview()).rejects.toMatchObject({ code: 'ACADEMIC_PERIOD_NOT_FOUND' });
  });

  it('marks history incomplete when scoped offerings reference an unavailable persisted period', async () => {
    await offering('missing-period', 'period-unavailable');
    await db.from('academic_periods').delete().eq('tenant_id', tenantId);
    const result = await new NativeAcademicProvider(context).getHistory();
    expect(result.periods).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_DATA_INCOMPLETE');
  });

  it('paginates own enrollments and limits the overview to 100 offerings with an explicit warning', async () => {
    for (let index = 0; index < 101; index++) await offering(`paginated-${String(index).padStart(3, '0')}`);
    const result = AcademicOverviewSchema.parse(await new NativeAcademicProvider(context).getOverview());
    expect(result.subjects).toHaveLength(100);
    expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('paginates activities and assessments in bounded queries and flags the 1000 activity ceiling', async () => {
    await offering('activities');
    await db.from('activities').insert(Array.from({ length: 1001 }, (_, index) => ({ id: `native-activity-${String(index).padStart(4, '0')}`, tenant_id: tenantId, class_id: 'activities', title: `Atividade ${index}`, type: 'assignment', due_date: `2026-${String(index).padStart(4, '0')}` })));
    await db.from('grades').insert({ tenant_id: tenantId, activity_id: 'native-activity-0999', student_id: 'native-student-auth', grade: 0, feedback: 'Ultima pagina', graded_at: null });
    const grades = jest.spyOn(GradesRepository.prototype, 'listAcademicAssessments');
    const result = AcademicOverviewSchema.parse(await new NativeAcademicProvider(context).getOverview());
    expect(result.subjects[0].activities).toHaveLength(1000);
    expect(result.subjects[0].activitiesComplete).toBe(false);
    expect(result.subjects[0].assessments).toHaveLength(1000);
    expect(result.subjects[0].assessments?.find(assessment => assessment.activityId === 'native-activity-0999')).toMatchObject({ grade: 0, feedback: 'Ultima pagina' });
    expect(grades.mock.calls.every(([params]) => params.activityIds.length <= 100 && params.pagination.limit === 100)).toBe(true);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('limits period envelopes to 32 and marks a larger catalog partial', async () => {
    await db.from('academic_periods').insert(Array.from({ length: 33 }, (_, index) => ({ id: `extra-period-${index}`, tenant_id: tenantId, code: `2030.${index}`, name: 'Periodo sintetico', status: 'planned' })));
    const result = AcademicPeriodsSchema.parse(await new NativeAcademicProvider(context).getPeriods());
    expect(result.periods).toHaveLength(32);
    expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('shares the 1000 activity budget across overview offerings', async () => {
    for (const classId of ['budget-a', 'budget-b']) {
      await offering(classId);
      await db.from('activities').insert(Array.from({ length: 600 }, (_, index) => ({ id: `${classId}-${String(index).padStart(4, '0')}`, tenant_id: tenantId, class_id: classId, title: 'Atividade sintetica', type: 'assignment' })));
    }
    const result = await new NativeAcademicProvider(context).getOverview();
    expect(result.subjects.flatMap(subject => subject.activities ?? [])).toHaveLength(1000);
    expect(result.subjects.flatMap(subject => subject.assessments ?? [])).toHaveLength(1000);
    expect(result.subjects.some(subject => subject.activitiesComplete === false)).toBe(true);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('bounds history to 320 offerings and 500 repository queries across all periods', async () => {
    await db.from('academic_periods').insert({ id: 'period-extra', tenant_id: tenantId, code: '2025.2', name: 'Periodo sintetico extra', status: 'closed' });
    for (const period of ['period-current', 'period-past', 'period-future', 'period-extra']) {
      for (let index = 0; index < 100; index++) await offering(`${period}-${String(index).padStart(3, '0')}`, period);
    }
    const users = jest.spyOn(UsersRepository.prototype, 'findById');
    const list = jest.spyOn(AcademicStructureRepository.prototype, 'list');
    const find = jest.spyOn(AcademicStructureRepository.prototype, 'find');
    const activities = jest.spyOn(ActivitiesRepository.prototype, 'listByClass');
    const grades = jest.spyOn(GradesRepository.prototype, 'listAcademicAssessments');
    const result = await new NativeAcademicProvider(context).getHistory();
    expect(result.periods.flatMap(period => period.subjects).length).toBeLessThanOrEqual(320);
    expect(users.mock.calls.length + list.mock.calls.length + find.mock.calls.length + activities.mock.calls.length + grades.mock.calls.length).toBeLessThanOrEqual(500);
    expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('shares the 2000 activity budget across all historical periods', async () => {
    for (const [index, period] of ['period-current', 'period-past', 'period-future'].entries()) {
      const classId = `history-budget-${index}`;
      await offering(classId, period);
      await db.from('activities').insert(Array.from({ length: 800 }, (_, activityIndex) => ({ id: `${classId}-${activityIndex}`, tenant_id: tenantId, class_id: classId, title: 'Atividade sintetica', type: 'assignment' })));
    }
    const result = await new NativeAcademicProvider(context).getHistory();
    expect(result.periods.flatMap(period => period.subjects.flatMap(subject => subject.activities ?? []))).toHaveLength(2000);
    expect(result.periods.some(period => period.subjects.some(subject => subject.activitiesComplete === false))).toBe(true);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('stops the response tail at the shared byte budget without truncating academic text', async () => {
    await offering('text-budget');
    const description = 'D'.repeat(102400);
    const feedback = 'F'.repeat(102400);
    const activities = Array.from({ length: 130 }, (_, index) => ({ id: `text-budget-${index}`, tenant_id: tenantId, class_id: 'text-budget', title: 'Atividade sintetica', description, type: 'assignment' }));
    await db.from('activities').insert(activities);
    await db.from('grades').insert(activities.map(activity => ({ tenant_id: tenantId, activity_id: activity.id, student_id: 'native-student-auth', grade: 0, feedback, graded_at: null })));
    const activityQueries = jest.spyOn(ActivitiesRepository.prototype, 'listByClass');
    const gradeQueries = jest.spyOn(GradesRepository.prototype, 'listAcademicAssessments');
    const result = await new NativeAcademicProvider(context).getOverview();
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.subjects[0].activities?.length).toBeGreaterThan(0);
    expect(result.subjects[0].activities?.every(activity => activity.description === description)).toBe(true);
    expect(result.subjects[0].assessments?.every(assessment => assessment.feedback === feedback)).toBe(true);
    expect(result.subjects[0].activitiesComplete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
    expect(activityQueries).toHaveBeenCalledTimes(1);
    expect(gradeQueries).toHaveBeenCalledTimes(1);
  });

  it('still chooses a persisted active period when the partial catalog omitted its ID', async () => {
    await db.from('academic_periods').insert(Array.from({ length: 33 }, (_, index) => ({ id: `aaa-period-${index}`, tenant_id: tenantId, code: `2030.${index}`, name: 'Periodo sintetico futuro', status: 'planned' })));
    const provider = new NativeAcademicProvider(context);
    expect((await provider.getPeriods()).periods.some(period => period.id === 'period-current')).toBe(false);
    const result = await provider.getOverview();
    expect(result.period.id).toBe('period-current');
    expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_LIMIT_EXCEEDED');
  });

  it('rejects an inactive or mismatched institutional member and rereads membership', async () => {
    const provider = new NativeAcademicProvider(context);
    await provider.getPeriods();
    await db.from('app_users').update({ active: false }).eq('tenant_id', tenantId).eq('id', context.userId);
    await expect(provider.getPeriods()).rejects.toMatchObject({ code: 'ACADEMIC_FORBIDDEN' });
    jest.spyOn(UsersRepository.prototype, 'findById').mockResolvedValue({ id: context.userId, tenantId: 'different', authUserId: 'other', role: 'student', name: 'Sintetico', email: 'other@example.invalid', active: true });
    await expect(provider.getOverview()).rejects.toMatchObject({ code: 'ACADEMIC_SCOPE_MISMATCH' });
  });

  it.each(['owner', 'admin', 'coordinator'])('rejects a personal academic overview for %s', async role => {
    await db.from('app_users').update({ role }).eq('tenant_id', tenantId).eq('id', context.userId);
    const provider = new NativeAcademicProvider(context);
    expect((await provider.getPeriods()).periods).toHaveLength(3);
    await expect(provider.getOverview()).rejects.toMatchObject({ code: 'ACADEMIC_FORBIDDEN' });
    await expect(provider.getHistory()).rejects.toMatchObject({ code: 'ACADEMIC_FORBIDDEN' });
  });

  it('shows only actively assigned teacher offerings and never reads student assessments', async () => {
    await offering('assigned'); await offering('unassigned'); await offering('inactive');
    await db.from('teaching_assignments').insert([
      { tenant_id: tenantId, class_id: 'assigned', teacher_id: 'native-teacher', status: 'active' },
      { tenant_id: tenantId, class_id: 'inactive', teacher_id: 'native-teacher', status: 'inactive' },
    ]);
    await db.from('activities').insert({ id: 'teacher-activity', tenant_id: tenantId, class_id: 'assigned', title: 'Docencia', type: 'assignment' });
    const grades = jest.spyOn(GradesRepository.prototype, 'listAcademicAssessments');
    const result = await new NativeAcademicProvider({ ...context, userId: 'native-teacher' }).getOverview();
    expect(result.subjects.map(subject => subject.classId)).toEqual(['assigned']);
    expect(result.subjects[0]).toMatchObject({ status: 'unknown', grades: null });
    expect(result.subjects[0].activities?.[0].activityId).toBe('teacher-activity');
    expect(result.subjects[0].assessments ?? []).toEqual([]);
    expect(grades).not.toHaveBeenCalled();
    await db.from('teaching_assignments').update({ status: 'inactive' }).eq('tenant_id', tenantId);
    expect((await new NativeAcademicProvider({ ...context, userId: 'native-teacher' }).getOverview()).subjects).toEqual([]);
  });

  it('marks unmapped legacy offerings and missing subjects as incomplete without guessed links', async () => {
    await offering('legacy'); await offering('missing-subject');
    await db.from('classes').update({ subject_id: null, academic_period_id: null }).eq('id', 'legacy');
    await db.from('subjects').delete().eq('tenant_id', tenantId).eq('id', 'subject-missing-subject');
    const result = await new NativeAcademicProvider(context).getOverview();
    expect(result.subjects).toEqual([]); expect(result.complete).toBe(false);
    expect(result.warnings.map(warning => warning.code)).toContain('ACADEMIC_DATA_INCOMPLETE');
  });

  it('propagates repository dependency failures instead of returning empty complete data', async () => {
    const failure = new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'Dependencia indisponivel.');
    jest.spyOn(AcademicStructureRepository.prototype, 'list').mockRejectedValue(failure);
    await expect(new NativeAcademicProvider(context).getPeriods()).rejects.toBe(failure);
  });

  it('copies the supplied context and does not expose mutable result objects', async () => {
    const input = structuredClone(context);
    const provider = new NativeAcademicProvider(input);
    input.userId = 'different'; input.tenant.id = 'different';
    const result = await provider.getPeriods();
    result.institution.name = 'Edited'; result.periods[0].name = 'Edited';
    expect((await provider.getPeriods()).institution).toEqual(context.tenant);
    expect((await provider.getPeriods()).periods[0].name).not.toBe('Edited');
  });
});
