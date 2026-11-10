import { z } from 'zod';
import { apiDateTime } from '../../shared/validation';

const content = z.string().trim().max(102400);
const deadline = apiDateTime({ offset: true })
  .refine(value => Number.isFinite(Date.parse(value)), 'Prazo invalido.')
  .transform(value => new Date(value).toISOString());

const assessmentSchema = z.object({
  stage: z.enum(['N1', 'N2']),
  category: z.enum(['exam', 'activity']),
  maxPoints: z.string().regex(/^\d+(?:\.\d{1,2})?$/, 'Informe pontos decimais com até duas casas.'),
}).strict().refine(({ category, maxPoints }) => Number(maxPoints) <= (category === 'exam' ? 7 : 3), {
  path: ['maxPoints'],
  message: 'A pontuação máxima excede o teto da categoria.',
});

export const activityCreateSchema = z.object({
  title: content.min(1), description: content.optional(), type: content.min(1).default('assignment'),
  dueDate: deadline.optional(), instructions: content.optional(), evaluationCriteria: content.optional(),
  priority: z.enum(['low','medium','high']).default('medium'), allowLate: z.boolean().default(false),
  state: z.literal('draft').optional(),
  assessment: assessmentSchema.optional(),
}).strict();
export const activityUpdateSchema = activityCreateSchema.omit({ state: true }).partial().extend({
  type: activityCreateSchema.shape.type.removeDefault().optional(),
  priority: activityCreateSchema.shape.priority.removeDefault().optional(),
  allowLate: activityCreateSchema.shape.allowLate.removeDefault().optional(),
  assessment: assessmentSchema.nullable().optional(),
  expectedVersion: z.number().int().min(1).max(2147483646).optional(),
}).strict().refine(input => Object.keys(input).some(key => key !== 'expectedVersion'), 'Informe uma alteracao.');
export const versionSchema = z.object({ expectedVersion: z.number().int().min(1).max(2147483646) }).strict();
export const answerSchema = z.object({ answer: z.string().trim().min(1).max(20000), expectedVersion: z.number().int().min(0).max(2147483646) }).strict();
export const reviewSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2147483646), submissionVersion: z.number().int().min(1).max(2147483646),
  grade: z.number().finite().min(0).max(10).refine(value => {
    const [coefficient, exponent = '0'] = value.toString().split('e');
    return (coefficient.split('.')[1]?.length ?? 0) - Number(exponent) <= 2;
  }, 'A nota deve ter no máximo duas casas decimais.').nullable().optional(), feedback: z.string().trim().max(20000).nullable().optional(), publish: z.boolean().default(false),
}).strict();
export const publishReviewSchema = z.object({ expectedRevision: z.number().int().min(1).max(2147483646) }).strict();
export const submissionIdSchema = z.guid();
export const legacyIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);
export const workflowPaginationSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export type ActivityInput = z.infer<typeof activityCreateSchema>;
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>;
export type ReviewInput = z.infer<typeof reviewSchema>;

export function activityPayload(input: ActivityInput | ActivityUpdate) {
  const aliases: Record<string,string> = { dueDate: 'due_date', evaluationCriteria: 'evaluation_criteria', allowLate: 'allow_late', expectedVersion: 'expected_version' };
  return Object.fromEntries(Object.entries(input).filter(([,value]) => value !== undefined).map(([key,value]) => [aliases[key] ?? key,value]));
}
