import { z } from 'zod';

export const AcademicIdSchema = z.union([z.string().min(1).max(128), z.number().int().positive().safe()]);
const text = z.string().max(2000).nullable().optional();
const academicContent = z.string().max(102400).nullable().optional();
const id = AcademicIdSchema.nullable().optional();
const number = z.number().finite().nonnegative().nullable().optional();
const status = z.enum(['in_progress', 'passed', 'failed', 'exempt', 'suspended', 'cancelled', 'completed', 'credited', 'not_taken', 'unknown']).nullable().optional();

export const AcademicSourceSchema = z.object({ providerId: z.string().min(1).max(64), demonstration: z.boolean(), label: z.string().min(1).max(200) }).strict();
export const AcademicScopeSchema = z.object({ userId: z.string().min(1), tenantId: z.string().min(1) }).strict();
export const AcademicInstitutionSchema = z.object({ id: z.string().min(1), name: z.string().min(1), slug: z.string().min(1) }).strict();
export const AcademicPeriodSchema = z.object({ id: AcademicIdSchema, name: text }).strict();
export const AcademicGradesSchema = z.object({ assessment1: number, assessment2: number, average: number, exam: number, finalAverage: number }).strict();
export const AcademicAttendanceSchema = z.object({ absences: number, absencePercentage: z.number().finite().min(0).max(100).nullable().optional() }).strict();
export const AcademicActivitySchema = z.object({
  id, activityId: id, offeringId: id, periodId: id, title: academicContent, description: academicContent, type: academicContent,
  status: z.enum(['validated', 'pending', 'cancelled', 'closed', 'unknown']).nullable().optional(),
  statusLabel: text, availability: text, returnDeadline: text, viewDeadline: text, hasAttachment: z.boolean().optional(),
  publicationState: z.enum(['draft','published','closed']).optional(), instructions: academicContent, evaluationCriteria: academicContent, priority: z.enum(['low','medium','high']).optional(), allowLate: z.boolean().optional(),
}).strict();
export const AcademicAssessmentSchema = z.object({
  activityId: AcademicIdSchema, title: academicContent, grade: number, feedback: academicContent, gradedAt: text,
}).strict();
export const AcademicSubjectSchema = z.object({
  id: AcademicIdSchema, offeringId: id, name: text, periodId: id, enrollmentSubjectId: id, classId: id, classSemester: z.union([z.string(), z.number()]).nullable().optional(), teachingPlanId: id,
  status, statusLabel: text, bulletinStatus: status, bulletinStatusLabel: text,
  attendance: AcademicAttendanceSchema.extend({ bulletin: AcademicAttendanceSchema.optional() }).strict(),
  grades: AcademicGradesSchema.nullable().optional(),
  assessments: z.array(AcademicAssessmentSchema).max(1000).optional(),
  activities: z.array(AcademicActivitySchema).max(1000).nullable().optional(), activitiesComplete: z.boolean().optional(),
}).strict();
export const AcademicWarningSchema = z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(500) }).strict();
const envelope = {
  source: AcademicSourceSchema, scope: AcademicScopeSchema, institution: AcademicInstitutionSchema,
  complete: z.boolean(), warnings: z.array(AcademicWarningSchema).max(1000),
};
export const AcademicPeriodsSchema = z.object({ ...envelope, periods: z.array(AcademicPeriodSchema).max(32) }).strict();
export const AcademicOverviewSchema = z.object({ ...envelope, period: AcademicPeriodSchema, subjects: z.array(AcademicSubjectSchema).max(100) }).strict();
export const AcademicHistorySchema = z.object({ ...envelope, periods: z.array(AcademicOverviewSchema).max(32) }).strict();

export type AcademicContext = { userId: string; tenant: z.infer<typeof AcademicInstitutionSchema> };
export type AcademicSource = z.infer<typeof AcademicSourceSchema>;
export type AcademicPeriod = z.infer<typeof AcademicPeriodSchema>;
export type AcademicSubject = z.infer<typeof AcademicSubjectSchema>;
export type AcademicOverview = z.infer<typeof AcademicOverviewSchema>;
export type AcademicPeriods = z.infer<typeof AcademicPeriodsSchema>;
export type AcademicHistory = z.infer<typeof AcademicHistorySchema>;
export interface AcademicProvider {
  readonly source: AcademicSource;
  getPeriods(): Promise<AcademicPeriods>;
  getOverview(options?: { periodId?: string | number }): Promise<AcademicOverview>;
  getHistory(): Promise<AcademicHistory>;
  close(): Promise<void>;
}
export type AcademicProviderFactory = (context: AcademicContext) => Promise<AcademicProvider>;
