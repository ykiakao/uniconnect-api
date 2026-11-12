import { AppUser } from '../../shared/types';
import { AcademicAccess } from '../../shared/academic-access';
import { canManageTenant } from '../../shared/roles';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { ActivitiesRepository } from './activities.repository';
import { ActivitiesService } from './activities.service';
import { ReviewInput } from './activities.workflow.schemas';
import { Review, Submission, SubmissionsRepository } from './activities.submissions.repository';
import { env } from '../../config/env';
import { AttachmentsRepository } from '../attachments/attachments.repository';

export function reviewResponse(review: Review) { return {grade:review.grade,feedback:review.feedback,gradedAt:review.graded_at,revision:review.revision,publicationState:review.publication_state,submissionVersion:review.submission_version}; }
function receipt(row:Submission, grade:Review|undefined, student:boolean) {
  const status = !grade ? (row.is_late ? 'late' : 'submitted') : grade.publication_state === 'published' ? 'result_published' : grade.grade === null ? 'in_review' : 'corrected';
  return {id:row.id,activityId:row.activity_id,studentId:row.student_id,version:row.current_version,answer:row.answer,submittedAt:row.submitted_at,isLate:row.is_late,status,
    result:grade && (!student || grade.publication_state==='published') ? reviewResponse(grade) : null};
}
export class SubmissionsService {
  private readonly repository = new SubmissionsRepository();
  private async receipts(user:AppUser,tenantId:string,rows:Submission[],grades:Review[] = []) {
    const results=rows.map(row=>receipt(row,grades.find(grade=>grade.submission_id===row.id),user.role==='student'));
    if(env.ACADEMIC_ATTACHMENTS_MODE==='disabled') return results;
    const files=await new AttachmentsRepository().versions({user,tenantId},rows.map(row=>({submissionId:row.id,version:row.current_version})));
    return results.map((row,index)=>({...row,attachments:files[index].attachments}));
  }
  private async staff(user:AppUser,tenantId:string,classId:string,correction=false) {
    if (user.tenantId!==tenantId || user.active===false || (correction ? user.role!=='teacher' : user.role!=='teacher'&&!canManageTenant(user.role))) throw new HttpError(403,'FORBIDDEN','Operacao academica nao autorizada.');
    await new AcademicAccess().require(user,tenantId,classId);
  }
  private async authorized(user:AppUser,tenantId:string,id:string,correction=false) {
    const row=await this.repository.find(tenantId,id);
    if (user.role==='student' && !correction) {
      if (row.student_id!==user.id) throw new HttpError(404,'SUBMISSION_NOT_FOUND','Entrega nao encontrada.');
    } else await this.staff(user,tenantId,row.class_id,correction);
    return row;
  }
  async submit(user:AppUser,tenantId:string,activityId:string,input:{answer:string;expectedVersion:number;attachmentIds?:string[]}) {
    if (user.role!=='student') throw new HttpError(403,'FORBIDDEN','Somente alunos podem enviar respostas.');
    const row=await this.repository.submit(tenantId,user.id,activityId,input.expectedVersion,input.answer,input.attachmentIds);
    return (await this.receipts(user,tenantId,[row]))[0];
  }
  async own(user:AppUser,tenantId:string,activityId:string) {
    if (user.role!=='student') throw new HttpError(403,'FORBIDDEN','Consulta pessoal restrita ao aluno.');
    await new ActivitiesService().findById({currentUser:user,tenantId,id:activityId});
    const row=await this.repository.own(tenantId,activityId,user.id);
    return row ? (await this.receipts(user,tenantId,[row],await this.repository.reviews(tenantId,[row.id])))[0] : {status:'not_submitted',submission:null};
  }
  async find(user:AppUser,tenantId:string,id:string) {
    const row=await this.authorized(user,tenantId,id);
    return (await this.receipts(user,tenantId,[row],await this.repository.reviews(tenantId,[row.id])))[0];
  }
  async list(user:AppUser,tenantId:string,activityId:string,pagination:Pagination) {
    const activity=await new ActivitiesRepository().findById({tenantId,id:activityId});
    await this.staff(user,tenantId,activity.classId);
    if (activity.assessment?.category==='exam') throw new HttpError(409,'EXAM_HAS_NO_SUBMISSIONS','Provas não recebem entregas.');
    const rows=await this.repository.list(tenantId,activityId,pagination);
    const grades=await this.repository.reviews(tenantId,rows.data.map(row=>row.id));
    return toPaginated({data:await this.receipts(user,tenantId,rows.data,grades),total:rows.total,page:pagination.page,limit:pagination.limit});
  }
  async history(user:AppUser,tenantId:string,id:string,pagination:Pagination) {
    await this.authorized(user,tenantId,id);
    const result=await this.repository.history(tenantId,id,user.role==='student',pagination);
    if(env.ACADEMIC_ATTACHMENTS_MODE==='disabled') return result;
    const files=await new AttachmentsRepository().versions({user,tenantId},result.versions.map(row=>({submissionId:id,version:Number(row.version)})));
    return {...result,versions:result.versions.map((row,index)=>({...row,attachments:files[index].attachments}))};
  }
  async review(user:AppUser,tenantId:string,id:string,input:ReviewInput) {
    await this.authorized(user,tenantId,id,true);
    const previous=(await this.repository.reviews(tenantId,[id]))[0];
    return reviewResponse(await this.repository.review(tenantId,user.id,id,{...input,grade:input.grade!==undefined?input.grade:previous?.grade??null,feedback:input.feedback!==undefined?input.feedback:previous?.feedback??null}));
  }
  async publish(user:AppUser,tenantId:string,id:string,expectedRevision:number) {
    await this.authorized(user,tenantId,id,true);
    return reviewResponse(await this.repository.publish(tenantId,user.id,id,expectedRevision));
  }
}
