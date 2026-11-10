import { z } from 'zod';
const uuid = z.guid();
const name = z.string().trim().min(1).max(200);
const code = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/).transform(value => value.toUpperCase());
export const PeriodSchema = z.object({ code, name, startDate: z.string().date().nullable().optional(), endDate: z.string().date().nullable().optional(), status: z.enum(['planned', 'active', 'closed', 'archived']).default('planned') }).strict();
export const SubjectSchema = z.object({ courseId: uuid, code, name, status: z.enum(['active', 'inactive']).default('active') }).strict();
export const OfferingSchema = z.object({ courseId: uuid, subjectId: uuid, periodId: uuid, name, status: z.enum(['active', 'closed', 'archived']).default('active'), teacherAuthId: uuid.optional() }).strict();
export const EnrollmentSchema = z.object({ classId: uuid, studentId: uuid, status: z.enum(['active', 'completed', 'cancelled', 'suspended']).default('active') }).strict();
export const AssignmentSchema = z.object({ classId: uuid, teacherId: uuid, status: z.enum(['active', 'inactive']).default('active') }).strict();
export const StatusEnrollmentSchema = EnrollmentSchema.pick({ status: true }).required().strict();
export const StatusAssignmentSchema = AssignmentSchema.pick({ status: true }).required().strict();
export type Resource = 'academic-periods' | 'subjects' | 'offerings' | 'enrollments' | 'teaching-assignments';
export const Resources: Resource[] = ['academic-periods', 'subjects', 'offerings', 'enrollments', 'teaching-assignments'];
export function validatePeriodDates(value: { startDate?: unknown; endDate?: unknown }) {
  if (typeof value.startDate === 'string' && typeof value.endDate === 'string' && value.startDate > value.endDate) {
    throw new z.ZodError([{ code: 'custom', path: ['endDate'], message: 'Data final anterior a inicial.' }]);
  }
}
