import { Request, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { requireTenantUser } from '../../middleware/auth-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { toPaginated } from '../../shared/pagination';
import { activityRpc } from '../activities/activities.workflow.rpc';
import { versionSchema, workflowPaginationSchema } from '../activities/activities.workflow.schemas';

const identifier = z.guid().transform(value => value.toLowerCase());
const points = z.string().regex(/^\d(?:\.\d{1,2})?$/);
const revision = z.number().int().min(0).max(2147483646);
const saveSchema = z.object({ points, expectedRevision: revision }).strict();
const publishSchema = z.object({ points: points.optional(), expectedRevision: revision.min(1) }).strict();

const grade = z.object({
  points,
  unit: z.literal('exam_points'),
  publicationState: z.enum(['draft', 'published']),
  revision: z.number().int().positive(),
  gradedAt: z.string().min(1),
});
const activation = z.object({ examId: identifier, revision: z.number().int().positive(), gradingOpenedAt: z.string().min(1) });
const exam = z.object({ examId: identifier, stage: z.enum(['N1', 'N2']), maxPoints: points });
const studentResult = exam.extend({ result: grade.extend({ publicationState: z.literal('published') }).nullable() });
const roster = exam.extend({
  gradingOpenedAt: z.string().nullable(),
  revision: z.number().int().positive(),
  data: z.array(z.object({ studentId: identifier, studentName: z.string(), result: grade.nullable() })),
  total: z.number().int().nonnegative().safe(),
});

export const examGradesRoutes = Router({ mergeParams: true });
examGradesRoutes.use(requireTenantUser);

function context(req: Request) {
  if (!req.tenant || !req.currentUser) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada.');
  return { p_tenant_id: req.tenant.id, p_actor_id: req.currentUser.id, p_exam_id: identifier.parse(req.params.activityId) };
}

function response<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta de prova inválida.');
  return parsed.data;
}

examGradesRoutes.post('/activate', createRateLimit({ max: 60, windowMs: 60000 }), async (req, res, next) => {
  try {
    const scope = context(req);
    const { expectedVersion } = versionSchema.parse(req.body);
    const value = await activityRpc('write_exam_grade', {
      ...scope, p_action: 'activate', p_expected: expectedVersion, p_student_id: null, p_points: null,
    });
    res.json(response(activation.extend({ examId: z.literal(scope.p_exam_id) }), value));
  } catch (error) { next(error); }
});

examGradesRoutes.get('/grades', async (req, res, next) => {
  try {
    const scope = context(req);
    const { page, limit } = workflowPaginationSchema.parse(req.query);
    const value = await activityRpc('read_exam_grades', {
      ...scope, p_student_view: false, p_offset: (page - 1) * limit, p_limit: limit,
    });
    const { data, total, ...metadata } = response(roster.extend({ examId: z.literal(scope.p_exam_id) }), value);
    res.json({ ...metadata, ...toPaginated({ data, total, page, limit }) });
  } catch (error) { next(error); }
});

examGradesRoutes.get('/grades/me', async (req, res, next) => {
  try {
    const scope = context(req);
    z.strictObject({}).parse(req.query);
    const value = await activityRpc('read_exam_grades', {
      ...scope, p_student_view: true, p_offset: 0, p_limit: 1,
    });
    res.json(response(studentResult.extend({ examId: z.literal(scope.p_exam_id) }), value));
  } catch (error) { next(error); }
});

function writeGrade(action: 'save' | 'publish'): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = (action === 'save' ? saveSchema : publishSchema).parse(req.body);
      const value = await activityRpc('write_exam_grade', {
        ...context(req), p_action: action, p_student_id: identifier.parse(req.params.studentId),
        p_expected: input.expectedRevision, p_points: input.points ?? null,
      });
      res.json(response(grade.extend({ publicationState: z.literal(action === 'save' ? 'draft' : 'published') }), value));
    } catch (error) { next(error); }
  };
}

examGradesRoutes.put('/grades/:studentId', createRateLimit({ max: 60, windowMs: 60000 }), writeGrade('save'));
examGradesRoutes.post('/grades/:studentId/publish', createRateLimit({ max: 60, windowMs: 60000 }), writeGrade('publish'));
