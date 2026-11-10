import { Request, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { requireTenantUser } from '../../middleware/auth-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { toPaginated } from '../../shared/pagination';
import { activityRpc } from '../activities/activities.workflow.rpc';
import { workflowPaginationSchema } from '../activities/activities.workflow.schemas';
import { calculateAcademicGrade } from './academic-grade-calculator';
import type { AssessmentItem, AssessmentScore, AssessmentStage } from './academic-grade-calculator';

const uuid = z.guid().transform(value => value.toLowerCase());
const stage = z.enum(['N1', 'N2']);
const noParameters = z.strictObject({});
const decimal = z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/);
const timestamp = z.string().min(1).nullable();
const itemSchema = z.object({
  id: uuid,
  stage,
  category: z.enum(['exam', 'activity']),
  maxPoints: decimal,
  available: z.boolean(),
  publishedValue: decimal.nullable(),
}).refine(item => item.available || item.publishedValue === null);
const cardSchema = z.object({
  studentId: z.string().min(1),
  studentName: z.string(),
  eligible: z.boolean(),
  closedStages: z.object({ N1: z.boolean(), N2: z.boolean() }),
  items: z.array(itemSchema),
});
const count = z.number().int().nonnegative().safe();
const cardsSchema = z.object({
  classId: uuid,
  closedAt: z.object({ N1: timestamp, N2: timestamp }),
  total: count,
  data: z.array(cardSchema),
});
const stageSchema = z.object({
  classId: uuid,
  stage,
  closedAt: timestamp,
  closedBy: uuid.nullable(),
  eligibleCount: count,
  assessmentCount: count,
  blockers: z.array(z.enum(['no_assessments', 'no_eligible_students', 'pending_assessments'])),
  total: count,
  data: z.array(z.object({
    studentId: uuid,
    itemId: uuid,
    title: z.string(),
    reason: z.enum(['assessment_unavailable', 'draft_grade', 'missing_grade']),
  })),
});

export const academicReportCardRoutes = Router({ mergeParams: true });
academicReportCardRoutes.use(requireTenantUser);

function context(req: Request, role: 'teacher' | 'student') {
  if (!req.tenant || !req.currentUser) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada.');
  if (req.currentUser.role !== role) throw new HttpError(403, 'FORBIDDEN', 'Consulta acadêmica não autorizada.');
  return { p_tenant_id: req.tenant.id, p_actor_id: req.currentUser.id, p_class_id: uuid.parse(req.params.classId) };
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta de boletim inválida.');
  return result.data;
}

function reportCard(card: z.infer<typeof cardSchema>, closedAt: z.infer<typeof cardsSchema>['closedAt'], summary: boolean) {
  const available = new Set(card.items.filter(item => item.available).map(item => item.id));
  const items: AssessmentItem[] = card.items.map(({ id, stage, category, maxPoints, publishedValue }) => {
    const score: AssessmentScore = publishedValue === null
      ? { publication: 'missing' }
      : { publication: 'published', value: publishedValue };
    const item = { id, stage, maxPoints };
    return category === 'exam' ? { ...item, category, directPoints: score } : { ...item, category, originalGrade: score };
  });
  let result: ReturnType<typeof calculateAcademicGrade>;
  try {
    result = calculateAcademicGrade(items, card.closedStages);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Dados de cálculo do boletim inválidos.');
  }
  const definitive = result.status !== 'pending' && result.status !== 'partial';
  function stageResult(key: AssessmentStage) {
    const { pendingItemIds, publishedItems, ...totals } = result.stages[key];
    const closed = closedAt[key] !== null;
    return {
      ...totals, closure: { state: closed ? 'closed' : 'open', closedAt: closedAt[key] },
      applies: closed ? card.closedStages[key] : card.eligible,
      pendingCount: pendingItemIds.length,
      ...(summary ? {} : { publishedItems, pendingItemIds: pendingItemIds.filter(id => available.has(id)) }),
    };
  }
  return {
    studentId: card.studentId, studentName: card.studentName,
    stages: { N1: stageResult('N1'), N2: stageResult('N2') },
    average: definitive ? result.average : null,
    status: definitive ? result.status : 'partial',
  };
}

function readCards(mode: 'self' | 'student' | 'summary'): RequestHandler {
  return async (req, res, next) => {
    try {
      const self = mode === 'self';
      const summary = mode === 'summary';
      const scope = context(req, self ? 'student' : 'teacher');
      if (!summary) noParameters.parse(req.query);
      const { page, limit } = summary ? workflowPaginationSchema.parse(req.query) : { page: 1, limit: 1 };
      const target = mode === 'student' ? uuid.parse(req.params.studentId) : null;
      const value = await activityRpc('read_academic_report_cards', {
        ...scope, p_student_id: target, p_self: self, p_offset: (page - 1) * limit, p_limit: limit,
      });
      const result = parseResponse(cardsSchema.extend({ classId: z.literal(scope.p_class_id) }), value);
      if (summary) {
        const data = result.data.map(card => reportCard(card, result.closedAt, true));
        res.json({ classId: result.classId, ...toPaginated({ data, total: result.total, page, limit }) });
        return;
      }
      const [card] = result.data;
      if (result.data.length !== 1 || card.studentId !== (self ? scope.p_actor_id : target)) {
        throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Escopo do boletim inválido.');
      }
      res.json({ classId: result.classId, ...reportCard(card, result.closedAt, false) });
    } catch (error) { next(error); }
  };
}

function manageStage(close: boolean): RequestHandler {
  return async (req, res, next) => {
    try {
      const scope = context(req, 'teacher');
      const target = stage.parse(req.params.stage);
      if (close) {
        noParameters.parse(req.query);
        noParameters.parse(req.body ?? {});
      }
      const { page, limit } = close ? { page: 1, limit: 1 } : workflowPaginationSchema.parse(req.query);
      const value = await activityRpc('manage_academic_stage', {
        ...scope, p_stage: target, p_close: close, p_offset: (page - 1) * limit, p_limit: limit,
      });
      const { data, total, closedAt, closedBy, ...metadata } = parseResponse(stageSchema.extend({
        classId: z.literal(scope.p_class_id), stage: z.literal(target),
        ...(close && { closedAt: z.string().min(1) }),
      }), value);
      res.json({
        ...metadata, closure: { state: closedAt === null ? 'open' : 'closed', closedAt, closedBy },
        ...toPaginated({ data, total, page, limit }),
      });
    } catch (error) { next(error); }
  };
}

academicReportCardRoutes.get('/me', readCards('self'));
academicReportCardRoutes.get('/students/:studentId', readCards('student'));
academicReportCardRoutes.get('/', readCards('summary'));
academicReportCardRoutes.get('/stages/:stage', manageStage(false));
academicReportCardRoutes.post('/stages/:stage/close', createRateLimit({ max: 30, windowMs: 60000 }), manageStage(true));
