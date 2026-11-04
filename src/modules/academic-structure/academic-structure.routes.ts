import { Request, Router } from 'express';
import { z } from 'zod';
import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { AcademicStructureService } from './academic-structure.service';
import { PeriodSchema, SubjectSchema, OfferingSchema, EnrollmentSchema, AssignmentSchema, StatusEnrollmentSchema, StatusAssignmentSchema, Resource } from './academic-structure.schemas';

const service = new AcademicStructureService();
const uuid = z.guid();
function context(req: Request) {
  if (!req.tenant || !req.currentUser) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituicao ausente.');
  return { tenantId: req.tenant.id, user: req.currentUser };
}
export function structureRoutes(resource: Resource) {
  const router = Router({ mergeParams: true });
  router.use(requireTenantUser);
  const schemas = { 'academic-periods': PeriodSchema, subjects: SubjectSchema, offerings: OfferingSchema, enrollments: EnrollmentSchema, 'teaching-assignments': AssignmentSchema };
  router.get('/', async (req, res, next) => {
    try {
      const { tenantId, user } = context(req);
      const query = z.object({ courseId: uuid.optional(), classId: uuid.optional(), periodId: uuid.optional(), studentId: uuid.optional(), teacherId: uuid.optional(), status: z.string().max(32).optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(req.query);
      const allowed: Record<Resource, string[]> = { 'academic-periods': ['status'], subjects: ['courseId', 'status'], offerings: ['courseId', 'periodId', 'status'], enrollments: ['classId', 'studentId', 'status'], 'teaching-assignments': ['classId', 'teacherId', 'status'] };
      const filters: Record<string, string> = {};
      for (const [key, value] of Object.entries(query)) if (typeof value === 'string') {
        if (!allowed[resource].includes(key)) throw new HttpError(400, 'VALIDATION_ERROR', 'Filtro incompativel.');
        filters[key] = value;
      }
      res.json(await service.list(resource, user, tenantId, filters, parsePagination(query)));
    } catch (error) { next(error); }
  });
  router.post('/', async (req, res, next) => {
    try { const { tenantId, user } = context(req); res.status(201).json(await service.create(resource, user, tenantId, schemas[resource].parse(req.body))); }
    catch (error) { next(error); }
  });
  router.get('/:id', async (req, res, next) => {
    try { const { tenantId, user } = context(req); res.json(await service.find(resource, user, tenantId, uuid.parse(req.params.id))); }
    catch (error) { next(error); }
  });
  router.patch('/:id', async (req, res, next) => {
    try {
      const { tenantId, user } = context(req);
      const schema = resource === 'enrollments' ? StatusEnrollmentSchema : resource === 'teaching-assignments' ? StatusAssignmentSchema
        : schemas[resource].partial().extend({ status: schemas[resource].shape.status.removeDefault().optional() });
      const body = schema.parse(req.body);
      if (Object.keys(body).length === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'Informe uma alteracao.');
      res.json(await service.update(resource, user, tenantId, uuid.parse(req.params.id), body));
    } catch (error) { next(error); }
  });
  if (resource === 'enrollments') router.get('/:id/history', async (req, res, next) => {
    try { const { tenantId, user } = context(req); res.json(await service.history(user, tenantId, uuid.parse(req.params.id))); }
    catch (error) { next(error); }
  });
  return router;
}
