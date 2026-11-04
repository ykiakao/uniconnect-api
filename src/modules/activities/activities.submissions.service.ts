import { AppUser } from '../../shared/types';
import { AcademicAccess } from '../../shared/academic-access';
import { canManageTenant } from '../../shared/roles';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { ActivitiesRepository } from './activities.repository';
import { ActivitiesService } from './activities.service';
import { ReviewInput } from './activities.workflow.schemas';
import { Review, Submission, SubmissionsRepository } from './activities.submissions.repository';

export function reviewResponse(review: Review) { return {grade:review.grade,feedback:review.feedback,gradedAt:review.graded_at,revision:review.revision,publicationState:review.publication_state,submissionVersion:review.submission_version}; }
function receipt(row:Submission, grade:Review|undefined, student:boolean) {
  const status = !grade ? (row.is_late ? 'late' : 'submitted') : grade.publication_state === 'published' ? 'result_published' : grade.grade === null ? 'in_review' : 'corrected';
  return {id:row.id,activityId:row.activity_id,studentId:row.student_id,version:row.current_version,answer:row.answer,submittedAt:row.submitted_at,isLate:row.is_late,status,
    result:grade && (!student || grade.publication_state==='published') ? reviewResponse(grade) : null};
}
export class SubmissionsService {
  private readonly repository = new SubmissionsRepository();
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
  async submit(user:AppUser,tenantId:string,activityId:string,input:{answer:string;expectedVersion:number}) {
    if (user.role!=='student') throw new HttpError(403,'FORBIDDEN','Somente alunos podem enviar respostas.');
    return receipt(await this.repository.submit(tenantId,user.id,activityId,input.expectedVersion,input.answer),undefined,true);
  }
  async own(user:AppUser,tenantId:string,activityId:string) {
    if (user.role!=='student') throw new HttpError(403,'FORBIDDEN','Consulta pessoal restrita ao aluno.');
    await new ActivitiesService().findById({currentUser:user,tenantId,id:activityId});
    const row=await this.repository.own(tenantId,activityId,user.id);
    return row ? receipt(row,(await this.repository.reviews(tenantId,[row.id]))[0],true) : {status:'not_submitted',submission:null};
  }
  async find(user:AppUser,tenantId:string,id:string) {
    const row=await this.authorized(user,tenantId,id);
    return receipt(row,(await this.repository.reviews(tenantId,[row.id]))[0],user.role==='student');
  }
  async list(user:AppUser,tenantId:string,activityId:string,pagination:Pagination) {
    const activity=await new ActivitiesRepository().findById({tenantId,id:activityId});
    await this.staff(user,tenantId,activity.classId);
    if (activity.assessment?.category==='exam') throw new HttpError(409,'EXAM_HAS_NO_SUBMISSIONS','Provas não recebem entregas.');
    const rows=await this.repository.list(tenantId,activityId,pagination);
    const grades=new Map((await this.repository.reviews(tenantId,rows.data.map(row=>row.id))).map(grade=>[grade.submission_id,grade]));
    return toPaginated({data:rows.data.map(row=>receipt(row,grades.get(row.id),false)),total:rows.total,page:pagination.page,limit:pagination.limit});
  }
  async history(user:AppUser,tenantId:string,id:string,pagination:Pagination) {
    await this.authorized(user,tenantId,id);
    return this.repository.history(tenantId,id,user.role==='student',pagination);
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
