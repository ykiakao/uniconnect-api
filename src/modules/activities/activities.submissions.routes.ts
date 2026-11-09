import { Request, Router } from 'express';
import { requireTenantUser } from '../../middleware/auth-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { answerSchema,publishReviewSchema,reviewSchema,submissionIdSchema,workflowPaginationSchema } from './activities.workflow.schemas';
import { SubmissionsService } from './activities.submissions.service';

const service=new SubmissionsService();
export const activitySubmissionsRoutes=Router({mergeParams:true});
export const submissionsRoutes=Router({mergeParams:true});
activitySubmissionsRoutes.use(requireTenantUser); submissionsRoutes.use(requireTenantUser);
function context(req:Request) {
  if (!req.currentUser||!req.tenant) throw new HttpError(400,'TENANT_REQUIRED','Instituicao nao informada.');
  return {user:req.currentUser,tenantId:req.tenant.id};
}
function pagination(req:Request) { const value=workflowPaginationSchema.parse(req.query); return {...value,offset:(value.page-1)*value.limit}; }
function activityId(req:Request) { return submissionIdSchema.parse(req.params.activityId); }
activitySubmissionsRoutes.post('/',createRateLimit({max:60,windowMs:60000}),async(req,res,next)=>{
  try { const c=context(req); res.status(201).json(await service.submit(c.user,c.tenantId,activityId(req),answerSchema.parse(req.body))); } catch(error){next(error);}
});
activitySubmissionsRoutes.get('/me',async(req,res,next)=>{
  try { const c=context(req); res.json(await service.own(c.user,c.tenantId,activityId(req))); } catch(error){next(error);}
});
activitySubmissionsRoutes.get('/',async(req,res,next)=>{
  try { const c=context(req); res.json(await service.list(c.user,c.tenantId,activityId(req),pagination(req))); } catch(error){next(error);}
});
submissionsRoutes.get('/:id/history',async(req,res,next)=>{
  try { const c=context(req); res.json(await service.history(c.user,c.tenantId,submissionIdSchema.parse(req.params.id),pagination(req))); } catch(error){next(error);}
});
submissionsRoutes.get('/:id',async(req,res,next)=>{
  try { const c=context(req); res.json(await service.find(c.user,c.tenantId,submissionIdSchema.parse(req.params.id))); } catch(error){next(error);}
});
submissionsRoutes.put('/:id/review',createRateLimit({max:60,windowMs:60000}),async(req,res,next)=>{
  try {
    const c=context(req);
    const id=submissionIdSchema.parse(req.params.id);
    const body=reviewSchema.safeParse(req.body);
    if (!body.success) {
      const precision=body.error.issues.find(issue=>issue.code==='custom' && issue.path.length===1 && issue.path[0]==='grade');
      if (precision) throw new HttpError(400,'VALIDATION_ERROR',precision.message);
      throw body.error;
    }
    res.json(await service.review(c.user,c.tenantId,id,body.data));
  } catch(error){next(error);}
});
submissionsRoutes.post('/:id/review/publish',createRateLimit({max:60,windowMs:60000}),async(req,res,next)=>{
  try { const c=context(req); res.json(await service.publish(c.user,c.tenantId,submissionIdSchema.parse(req.params.id),publishReviewSchema.parse(req.body).expectedRevision)); } catch(error){next(error);}
});
