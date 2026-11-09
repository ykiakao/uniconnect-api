import { Request, Router } from 'express';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { ActivitiesService } from './activities.service';
import { activityCreateSchema,activityUpdateSchema,legacyIdSchema,submissionIdSchema,versionSchema,workflowPaginationSchema } from './activities.workflow.schemas';
import { createRateLimit } from '../../middleware/rate-limit';

const activitiesService = new ActivitiesService();

export const classActivitiesRoutes = Router({ mergeParams: true });
export const activitiesRoutes = Router({ mergeParams: true });

classActivitiesRoutes.use(requireTenantUser);
activitiesRoutes.use(requireTenantUser);

function requireContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'InstituiÃ§Ã£o nÃ£o informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

function getParam(request: Request, key: string) {
  return legacyIdSchema.parse((request.params as Record<string, string>)[key]);
}

classActivitiesRoutes.get('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await activitiesService.listByClass({
      currentUser,
      tenantId: tenant.id,
      classId: getParam(request, 'classId'),
      pagination: parsePagination(workflowPaginationSchema.parse(request.query)),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

classActivitiesRoutes.post('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = activityCreateSchema.parse(request.body);
    const result = await activitiesService.create({
      currentUser,
      tenantId: tenant.id,
      classId: getParam(request, 'classId'),
      ...body,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

activitiesRoutes.get('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await activitiesService.findById({
      currentUser,
      tenantId: tenant.id,
      id: getParam(request,'id'),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

activitiesRoutes.put('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = activityUpdateSchema.parse(request.body);
    const result = await activitiesService.update({
      currentUser,
      tenantId: tenant.id,
      id: getParam(request,'id'),
      ...body,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

activitiesRoutes.delete('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    await activitiesService.delete({
      currentUser,
      tenantId: tenant.id,
      id: getParam(request,'id'),
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

for (const operation of ['publish','close'] as const) activitiesRoutes.post(`/:id/${operation}`,createRateLimit({max:120,windowMs:60000}),async(req,res,next)=>{
  try {
    const {tenant,currentUser}=requireContext(req);
    const body=versionSchema.parse(req.body);
    res.json(await activitiesService.transition({currentUser,tenantId:tenant.id,id:submissionIdSchema.parse(req.params.id),expectedVersion:body.expectedVersion},operation));
  } catch(error){next(error);}
});
