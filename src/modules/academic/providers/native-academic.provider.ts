import { AppUser } from '../../../shared/types';
import { Pagination } from '../../../shared/pagination';
import { HttpError } from '../../../shared/http-error';
import { ActivitiesRepository } from '../../activities/activities.repository';
import { AcademicStructureRepository, StructureRecord } from '../../academic-structure/academic-structure.repository';
import { Resource } from '../../academic-structure/academic-structure.schemas';
import { GradesRepository } from '../../grades/grades.repository';
import { UsersRepository } from '../../users/users.repository';
import { AcademicContext, AcademicHistory, AcademicOverview, AcademicPeriod, AcademicPeriods, AcademicProvider, AcademicSource, AcademicSubject } from '../academic.contracts';
import { AcademicError } from '../academic.errors';

type Warnings = AcademicOverview['warnings'];
type ScopeData = { user: AppUser; offerings: StructureRecord[]; enrollments: Map<string, StructureRecord>; warnings: Warnings };
type Budget = { queries: number; offerings: number; activities: number; bytes: number; textExhausted: boolean };
const pageSize = 100;
const scopeLimit = 3200;
function requestBudget(history = false): Budget { return { queries: 1, offerings: history ? 320 : 100, activities: history ? 2000 : 1000, bytes: 2 * 1024 * 1024 - 64 * 1024, textExhausted: false }; }

function warn(warnings: Warnings, code: string, message: string) {
  if (!warnings.some(warning => warning.code === code)) warnings.push({ code, message });
}
function incomplete(warnings: Warnings) {
  warn(warnings, 'ACADEMIC_DATA_INCOMPLETE', 'Há vínculos ou registros acadêmicos incompletos; os dados disponíveis não representam todo o histórico.');
}
function limited(warnings: Warnings) {
  warn(warnings, 'ACADEMIC_LIMIT_EXCEEDED', 'O volume de dados excede o limite desta consulta; o resultado é parcial.');
}
function queryAvailable(budget: Budget, warnings: Warnings) {
  if (budget.queries >= 500 || budget.textExhausted) { limited(warnings); return false; }
  budget.queries++;
  return true;
}
function reserveText(value: unknown, budget: Budget, warnings: Warnings) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > budget.bytes) { budget.textExhausted = true; limited(warnings); return false; }
  budget.bytes -= bytes;
  return true;
}
function field(row: StructureRecord, key: string) { return typeof row[key] === 'string' && row[key] ? row[key] as string : undefined; }
function periodOf(row: StructureRecord): AcademicPeriod { return { id: row.id, name: field(row, 'name') ?? null }; }

async function pages<T>(read: (pagination: Pagination) => Promise<{ rows: T[]; total: number }>, maximum: number, warnings: Warnings, budget: Budget): Promise<T[]> {
  const rows: T[] = [];
  if (maximum <= 0) { limited(warnings); return rows; }
  for (let page = 1; ; page++) {
    if (!queryAvailable(budget, warnings)) break;
    const offset = (page - 1) * pageSize;
    const result = await read({ page, limit: pageSize, offset });
    if (!Number.isSafeInteger(result.total) || result.total < 0) throw new AcademicError('ACADEMIC_INVALID_RESPONSE');
    if (result.total > maximum) limited(warnings);
    rows.push(...result.rows.slice(0, maximum - rows.length));
    if (rows.length >= Math.min(result.total, maximum)) break;
    if (result.rows.length < pageSize) { incomplete(warnings); break; }
  }
  return rows;
}

export class NativeAcademicProvider implements AcademicProvider {
  readonly source: AcademicSource = { providerId: 'native', demonstration: false, label: 'Dados acadêmicos institucionais do UniConnect' };
  private readonly context: AcademicContext;
  private readonly users = new UsersRepository();
  private readonly structure = new AcademicStructureRepository();
  private readonly activities = new ActivitiesRepository();
  private readonly grades = new GradesRepository();
  constructor(context: AcademicContext) { this.context = structuredClone(context); }

  private envelope(warnings: Warnings) {
    return { source: { ...this.source }, scope: { userId: this.context.userId, tenantId: this.context.tenant.id }, institution: { ...this.context.tenant }, complete: warnings.length === 0, warnings: structuredClone(warnings) };
  }

  private async member(personal = false) {
    let user: AppUser;
    try { user = await this.users.findById({ tenantId: this.context.tenant.id, id: this.context.userId }); }
    catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) throw new AcademicError('ACADEMIC_FORBIDDEN');
      throw error;
    }
    if (user.id !== this.context.userId || user.tenantId !== this.context.tenant.id) throw new AcademicError('ACADEMIC_SCOPE_MISMATCH');
    if (user.active === false || (personal && user.role !== 'student' && user.role !== 'teacher')) throw new AcademicError('ACADEMIC_FORBIDDEN');
    return user;
  }

  private async list(resource: Resource, filters: Record<string, string>, maximum: number, warnings: Warnings, budget: Budget, classIds?: string[]) {
    const records = await pages(async pagination => {
      const result = await this.structure.list(resource, this.context.tenant.id, filters, pagination, classIds);
      return { rows: result.data, total: result.meta.total };
    }, maximum, warnings, budget);
    if (records.some(row => row.tenantId !== this.context.tenant.id)) throw new AcademicError('ACADEMIC_SCOPE_MISMATCH');
    return records;
  }

  private async periods(warnings: Warnings, budget: Budget) {
    return (await this.list('academic-periods', {}, 32, warnings, budget)).sort((a, b) => (field(b, 'code') ?? '').localeCompare(field(a, 'code') ?? ''));
  }

  async getPeriods(): Promise<AcademicPeriods> {
    await this.member();
    const budget = requestBudget();
    const warnings: Warnings = [];
    const periods = await this.periods(warnings, budget);
    const result: AcademicPeriod[] = [];
    for (const period of periods) {
      const mapped = periodOf(period);
      if (!reserveText(mapped, budget, warnings)) break;
      result.push(mapped);
    }
    return { ...this.envelope(warnings), periods: result };
  }

  private async scope(user: AppUser, budget: Budget): Promise<ScopeData> {
    const warnings: Warnings = [];
    const student = user.role === 'student';
    const links = await this.list(student ? 'enrollments' : 'teaching-assignments', student ? { studentId: user.id } : { teacherId: user.id, status: 'active' }, scopeLimit, warnings, budget);
    const enrollments = new Map<string, StructureRecord>();
    const classIds = new Set<string>();
    for (const link of links) {
      const classId = field(link, 'classId');
      if (!classId || link[student ? 'studentId' : 'teacherId'] !== user.id || (!student && link.status !== 'active') || (student && !['active', 'completed', 'cancelled', 'suspended'].includes(String(link.status)))) { incomplete(warnings); continue; }
      if (student && enrollments.has(classId)) { incomplete(warnings); continue; }
      classIds.add(classId);
      if (student) enrollments.set(classId, link);
    }
    const ids = [...classIds];
    const offerings: StructureRecord[] = [];
    for (let index = 0; index < ids.length; index += pageSize) {
      if (budget.queries >= 500 || budget.textExhausted) { limited(warnings); break; }
      offerings.push(...await this.list('offerings', {}, pageSize, warnings, budget, ids.slice(index, index + pageSize)));
    }
    if (offerings.length !== classIds.size || offerings.some(offering => !classIds.has(offering.id))) incomplete(warnings);
    return { user, offerings: offerings.filter(offering => classIds.has(offering.id)), enrollments, warnings };
  }

  private async find(resource: Resource, id: string, warnings: Warnings, budget: Budget) {
    if (!queryAvailable(budget, warnings)) return undefined;
    try {
      const row = await this.structure.find(resource, this.context.tenant.id, id);
      if (row.tenantId !== this.context.tenant.id || row.id !== id) throw new AcademicError('ACADEMIC_SCOPE_MISMATCH');
      return row;
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) { incomplete(warnings); return undefined; }
      throw error;
    }
  }

  private async subjectActivities(classId: string, periodId: string, user: AppUser, warnings: Warnings, budget: Budget) {
    const activityWarnings: Warnings = [];
    const maximum = Math.min(1000, budget.activities);
    const mappedActivities: NonNullable<AcademicSubject['activities']> = [];
    const mappedAssessments: NonNullable<AcademicSubject['assessments']> = [];
    let read = 0;
    if (maximum <= 0) limited(activityWarnings);
    for (let page = 1; read < maximum; page++) {
      if (!queryAvailable(budget, activityWarnings)) break;
      const offset = (page - 1) * pageSize;
      const result = await this.activities.listByClass({ tenantId: this.context.tenant.id, classId, pagination: { page, limit: pageSize, offset },...(user.role==='student'?{studentId:user.id}:{}) });
      if (!Number.isSafeInteger(result.total) || result.total < 0) throw new AcademicError('ACADEMIC_INVALID_RESPONSE');
      if (result.total > maximum) limited(activityWarnings);
      const batch = result.activities.slice(0, maximum - read);
      read += batch.length;
      budget.activities -= batch.length;
      const authorized = batch.filter(activity => {
        if (activity.classId !== classId) { incomplete(activityWarnings); return false; }
        return true;
      });
      const grades = new Map<string, Awaited<ReturnType<GradesRepository['listAcademicAssessments']>>['grades'][number]>();
      const activityIds = authorized.map(activity => activity.id);
      if (user.role === 'student' && activityIds.length) {
        const rows = await pages(async pagination => {
          const result = await this.grades.listAcademicAssessments({ tenantId: this.context.tenant.id, studentAuthUserId: user.authUserId, activityIds, pagination });
          return { rows: result.grades, total: result.total };
        }, activityIds.length, activityWarnings, budget);
        for (const grade of rows) {
          if (!activityIds.includes(grade.activityId) || grades.has(grade.activityId)) { incomplete(activityWarnings); continue; }
          grades.set(grade.activityId, grade);
        }
      }
      for (const activity of authorized) {
        const grade = grades.get(activity.id);
        const mapped = { id: activity.id, activityId: activity.id, offeringId: classId, periodId, title: activity.title ?? null, description: activity.description ?? null, type: activity.type ?? null, returnDeadline: activity.dueDate ?? null, status: activity.state==='closed'?'closed' as const:'unknown' as const,publicationState:activity.state,instructions:activity.instructions??null,evaluationCriteria:activity.evaluationCriteria??null,priority:activity.priority,allowLate:activity.allowLate };
        const assessment = user.role === 'student' ? { activityId: activity.id, title: activity.title ?? null, grade: grade?.grade ?? null, feedback: grade?.feedback ?? null, gradedAt: grade?.gradedAt ?? null } : undefined;
        if (!reserveText({ activity: mapped, assessment }, budget, activityWarnings)) break;
        mappedActivities.push(mapped);
        if (assessment) mappedAssessments.push(assessment);
      }
      if (budget.textExhausted || read >= Math.min(result.total, maximum)) break;
      if (result.activities.length < pageSize) { incomplete(activityWarnings); break; }
    }
    for (const warning of activityWarnings) warn(warnings, warning.code, warning.message);
    return { activities: mappedActivities, activitiesComplete: activityWarnings.length === 0, ...(user.role === 'student' ? { assessments: mappedAssessments } : {}) };
  }

  private async overview(period: StructureRecord, scope: ScopeData, initialWarnings: Warnings, knownPeriods: Set<string>, allPeriodsKnown: boolean, budget: Budget): Promise<AcademicOverview> {
    const warnings = structuredClone(initialWarnings);
    for (const offering of scope.offerings) {
      if (!field(offering, 'subjectId') || !field(offering, 'periodId') || (allPeriodsKnown && !knownPeriods.has(String(offering.periodId)))) incomplete(warnings);
    }
    const offerings = scope.offerings.filter(offering => offering.periodId === period.id);
    if (offerings.length > 100) limited(warnings);
    const subjects: AcademicSubject[] = [];
    for (const offering of offerings.slice(0, 100)) {
      if (budget.offerings <= 0 || budget.activities <= 0 || budget.queries >= 500 || budget.textExhausted) { limited(warnings); break; }
      budget.offerings--;
      const subjectId = field(offering, 'subjectId');
      if (!subjectId) continue;
      const subject = await this.find('subjects', subjectId, warnings, budget);
      if (!subject || subject.courseId !== offering.courseId) { incomplete(warnings); continue; }
      const enrollment = scope.enrollments.get(offering.id);
      const status: AcademicSubject['status'] = scope.user.role === 'student' ? (enrollment?.status === 'active' ? 'in_progress' : enrollment?.status as 'completed' | 'cancelled' | 'suspended') : 'unknown';
      const mapped = { id: subject.id, name: field(subject, 'name') ?? null, classId: offering.id, offeringId: offering.id, periodId: period.id, ...(enrollment ? { enrollmentSubjectId: enrollment.id } : {}), status, grades: null, attendance: { absences: null, absencePercentage: null } };
      if (!reserveText(mapped, budget, warnings)) break;
      subjects.push({ ...mapped, ...await this.subjectActivities(offering.id, period.id, scope.user, warnings, budget) });
    }
    if (subjects.length) {
      warn(warnings, 'ATTENDANCE_UNAVAILABLE', 'A frequência não está disponível nesta fonte institucional.');
      warn(warnings, 'AGGREGATES_UNAVAILABLE', 'Médias e resultados finais institucionais não estão disponíveis; avaliações individuais não representam médias.');
    }
    return { ...this.envelope(warnings), period: periodOf(period), subjects };
  }

  async getOverview({ periodId }: { periodId?: string | number } = {}): Promise<AcademicOverview> {
    const user = await this.member(true);
    const budget = requestBudget();
    const warnings: Warnings = [];
    const periods = await this.periods(warnings, budget);
    let period = periodId === undefined ? periods.find(row => row.status === 'active') ?? periods[0] : periods.find(row => row.id === String(periodId));
    if (periodId === undefined && warnings.some(warning => warning.code === 'ACADEMIC_LIMIT_EXCEEDED')) {
      const active = await this.list('academic-periods', { status: 'active' }, 32, warnings, budget);
      active.sort((a, b) => (field(b, 'code') ?? '').localeCompare(field(a, 'code') ?? ''));
      period = active[0] ?? period;
    }
    if (!period && periodId !== undefined) period = await this.find('academic-periods', String(periodId), [], budget);
    if (!period) throw new AcademicError('ACADEMIC_PERIOD_NOT_FOUND');
    reserveText(periodOf(period), budget, warnings);
    const scope = await this.scope(user, budget);
    for (const warning of scope.warnings) warn(warnings, warning.code, warning.message);
    return this.overview(period, scope, warnings, new Set([...periods.map(row => row.id), period.id]), !warnings.some(warning => warning.code === 'ACADEMIC_LIMIT_EXCEEDED'), budget);
  }

  async getHistory(): Promise<AcademicHistory> {
    const user = await this.member(true);
    const budget = requestBudget(true);
    const warnings: Warnings = [];
    const periods = await this.periods(warnings, budget);
    const scope = await this.scope(user, budget);
    for (const warning of scope.warnings) warn(warnings, warning.code, warning.message);
    if (!periods.length && scope.offerings.length) incomplete(warnings);
    const result: AcademicOverview[] = [];
    for (const period of periods) {
      if (budget.offerings <= 0 || budget.activities <= 0 || budget.queries >= 500 || budget.textExhausted) { limited(warnings); break; }
      if (!reserveText(periodOf(period), budget, warnings)) break;
      result.push(await this.overview(period, scope, warnings, new Set(periods.map(row => row.id)), !warnings.some(warning => warning.code === 'ACADEMIC_LIMIT_EXCEEDED'), budget));
    }
    for (const overview of result) for (const warning of overview.warnings) warn(warnings, warning.code, warning.message);
    return { ...this.envelope(warnings), periods: result };
  }
  async close(): Promise<void> {}
}
