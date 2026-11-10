import { randomUUID } from 'node:crypto';

type Row=Record<string,unknown>;
type Store=Record<string,Row[]>;
type RpcResult={data:unknown;error:{code:string;message:string}|null;status:number};
class Rejected { constructor(readonly code:string){} }
function reject(code='23514'):never {throw new Rejected(code);}

export function mockActivityRpc(name:string,args:Row,db:Store):RpcResult|undefined {
  if (!['manage_academic_activity','submit_activity_answer','review_activity_submission','publish_activity_review','list_academic_activities','record_activity_grade'].includes(name)) return undefined;
  for(const table of ['activity_submissions','activity_submission_versions','grade_revisions']) db[table]??=[];
  const tenant=args.p_tenant_id;
  const scoped=(table:string)=>db[table].filter(row=>row.tenant_id===tenant);
  try {
    const actor=scoped('app_users').find(row=>row.id===args.p_actor_id);
    if(!actor||actor.active===false) return reject('42501');
    const manager=['owner','admin','coordinator'].includes(String(actor.role));
    const teacher=(classId:unknown)=>actor.role==='teacher'&&scoped('teaching_assignments').some(row=>row.class_id===classId&&row.teacher_id===actor.id&&row.status==='active');
    const result=(data:unknown):RpcResult=>({data:structuredClone(data),error:null,status:200});
    const activity=(id:unknown)=>scoped('activities').find(row=>row.id===id)??reject('P0002');
    const classRow=(id:unknown)=>scoped('classes').find(row=>row.id===id)??reject('P0002');
    const activeOffering=(offering:Row)=>{
      const period=scoped('academic_periods').find(row=>row.id===offering.academic_period_id);
      const subject=scoped('subjects').find(row=>row.id===offering.subject_id);
      if(!offering.subject_id||!offering.academic_period_id||offering.academic_status!=='active'||period?.status!=='active'||subject?.status!=='active') reject();
    };
    const enrollment=(classId:unknown,studentId:unknown)=>scoped('enrollments').find(row=>row.class_id===classId&&row.student_id===studentId);
    const audit=(grade:Row)=>db.grade_revisions.push({...structuredClone(grade),id:randomUUID(),grade_id:grade.id,captured_at:new Date().toISOString()});

    if(name==='list_academic_activities') {
      if(actor.role!=='student') reject('42501');
      classRow(args.p_class_id);
      const link=enrollment(args.p_class_id,actor.id);
      const rows=scoped('activities').filter(row=>row.class_id===args.p_class_id&&(!args.p_activity_id||row.id===args.p_activity_id)&&['published','closed'].includes(String(row.state??'published'))&&link&&(
        ['active','completed'].includes(String(link.status))||scoped('activity_submissions').some(sub=>sub.activity_id===row.id&&sub.student_id===actor.id)||scoped('grades').some(grade=>grade.activity_id===row.id&&grade.student_id===actor.auth_user_id&&(grade.publication_state??'published')==='published')));
      rows.sort((a,b)=>String(a.due_date??'\uffff').localeCompare(String(b.due_date??'\uffff'))||String(a.id).localeCompare(String(b.id)));
      return result({activities:rows.slice(Number(args.p_offset),Number(args.p_offset)+Number(args.p_limit)),total:rows.length});
    }
    if(name==='manage_academic_activity') {
      const input=args.p_payload&&typeof args.p_payload==='object'?args.p_payload as Row:{};
      const operation=args.p_operation;
      const row=operation==='create'?undefined:activity(args.p_activity_id);
      const offering=classRow(row?.class_id??args.p_class_id);
      if(!manager&&!teacher(offering.id)) reject('42501');
      const assessment = input.assessment as { stage: string; category: string; maxPoints: string } | null | undefined;
      const assessmentColumns = assessment === undefined ? {} : {
        assessment_stage: assessment?.stage ?? null,
        assessment_category: assessment?.category ?? null,
        assessment_max_points: assessment ? Number(assessment.maxPoints) : null,
      };
      if (operation === 'update' && assessment !== undefined && row?.state !== 'draft'
        && Object.entries(assessmentColumns).some(([key, value]) => (row?.[key] ?? null) !== value)) reject();
      if(operation==='create') {
        activeOffering(offering);
        const now=new Date().toISOString();
        const created={id:randomUUID(),tenant_id:tenant,class_id:offering.id,title:input.title,description:input.description??null,type:input.type??'assignment',due_date:input.due_date??null,instructions:input.instructions??null,evaluation_criteria:input.evaluation_criteria??null,priority:input.priority??'medium',allow_late:input.allow_late??false,state:'draft',workflow_enabled:true,revision:1,created_by:actor.auth_user_id,created_at:now,updated_at:now,published_at:null,closed_at:null};
        Object.assign(created, assessmentColumns);
        db.activities.push(created);return result(created);
      }
      if(!row) reject('P0002');
      if(operation!=='delete'&&(row.workflow_enabled||input.expected_version!==undefined)&&input.expected_version!==(row.revision??1)) reject();
      const hasSubmission=scoped('activity_submissions').some(sub=>sub.activity_id===row.id);
      if(operation==='delete') {
        if(row.assessment_stage && row.state!=='draft') reject();
        if(hasSubmission||scoped('grades').some(grade=>grade.activity_id===row.id)) reject();
        db.activities=db.activities.filter(candidate=>candidate!==row);return result(row);
      }
      if(operation==='publish') {
        if(!teacher(offering.id)) reject('42501');
        activeOffering(offering);
        if(row.state!=='draft'||row.assessment_category==='exam') reject();
        row.state='published';row.published_at=new Date().toISOString();
      } else if(operation==='close') {
        if(row.state!=='published') reject();
        row.state='closed';row.closed_at=new Date().toISOString();
      } else if(operation==='update') {
        if(row.state==='closed') reject();
        for(const [key,value]of Object.entries(input)) {
          if(key==='expected_version'||key==='assessment') continue;
          if(hasSubmission&&key!=='due_date'&&value!==row[key]) reject();
          if(hasSubmission&&key==='due_date'&&(!row.due_date||new Date(String(value)).getTime()<new Date(String(row.due_date)).getTime())) reject();
          row[key]=value;
        }
        Object.assign(row, assessmentColumns);
      } else reject('22023');
      row.revision=Number(row.revision??1)+1;row.updated_at=new Date().toISOString();return result(row);
    }
    if(name==='submit_activity_answer') {
      if(actor.role!=='student') reject('42501');
      const task=activity(args.p_activity_id),offering=classRow(task.class_id);
      activeOffering(offering);
      if(enrollment(task.class_id,actor.id)?.status!=='active') reject('42501');
      if((task.state??'published')!=='published') reject();
      const late=!!task.due_date&&Date.now()>Date.parse(String(task.due_date));
      if(late&&!task.allow_late) reject();
      if(scoped('grades').some(row=>row.activity_id===task.id&&row.student_id===actor.auth_user_id)) reject();
      let row=scoped('activity_submissions').find(sub=>sub.activity_id===task.id&&sub.student_id===actor.id);
      if(Number(row?.current_version??0)!==args.p_expected_version) reject();
      const values={current_version:Number(row?.current_version??0)+1,answer:args.p_answer,submitted_at:new Date().toISOString(),is_late:late};
      if(row)Object.assign(row,values);else{row={id:randomUUID(),tenant_id:tenant,activity_id:task.id,class_id:task.class_id,student_id:actor.id,...values};db.activity_submissions.push(row);}
      db.activity_submission_versions.push({tenant_id:tenant,submission_id:row.id,version:row.current_version,answer:row.answer,submitted_at:row.submitted_at,is_late:late});
      return result(row);
    }
    if(name==='record_activity_grade') {
      const task=activity(args.p_activity_id),student=scoped('app_users').find(row=>row.id===args.p_student_id);
      if(!teacher(task.class_id)&&!manager)reject('42501');
      if(!student||student.role!=='student'||student.active===false)reject('42501');
      if(!['active','completed'].includes(String(enrollment(task.class_id,student.id)?.status)))reject();
      if(task.state==='draft'||scoped('activity_submissions').some(row=>row.activity_id===task.id&&row.student_id===student.id))reject();
      let grade=scoped('grades').find(row=>row.activity_id===task.id&&row.student_id===student.auth_user_id);
      const values={grade:args.p_grade,feedback:args.p_feedback,publication_state:'published',revision:Number(grade?.revision??0)+1,graded_by:actor.auth_user_id,graded_at:new Date().toISOString(),submission_id:null,submission_version:null};
      if(grade)Object.assign(grade,values);else{grade={id:randomUUID(),tenant_id:tenant,activity_id:task.id,student_id:student.auth_user_id,grade_unit:'score_0_10',...values};db.grades.push(grade);}
      audit(grade);return result(grade);
    }
    const sub=scoped('activity_submissions').find(row=>row.id===args.p_submission_id)??reject('P0002');
    const task=activity(sub.activity_id);
    if(!teacher(sub.class_id)) reject('42501');
    const student=scoped('app_users').find(row=>row.id===sub.student_id);
    if(!student||!enrollment(sub.class_id,student.id))reject();
    let grade=scoped('grades').find(row=>row.activity_id===task.id&&row.student_id===student.auth_user_id);
    if(Number(grade?.revision??0)!==args.p_expected_revision)reject();
    if(name==='publish_activity_review') {
      if(!grade||grade.publication_state!=='draft')reject();
      Object.assign(grade,{publication_state:'published',revision:Number(grade.revision)+1,graded_by:actor.auth_user_id,graded_at:new Date().toISOString()});
    } else {
      if(sub.current_version!==args.p_submission_version||grade?.publication_state==='published'&&!args.p_publish)reject();
      const values={grade:args.p_grade,feedback:args.p_feedback,publication_state:args.p_publish?'published':'draft',revision:Number(grade?.revision??0)+1,graded_by:actor.auth_user_id,graded_at:new Date().toISOString(),submission_id:sub.id,submission_version:sub.current_version};
      if(grade)Object.assign(grade,values);else{grade={id:randomUUID(),tenant_id:tenant,activity_id:task.id,student_id:student.auth_user_id,grade_unit:'score_0_10',...values};db.grades.push(grade);}
    }
    audit(grade);return result(grade);
  } catch(error) {
    if(error instanceof Rejected)return{data:null,error:{code:error.code,message:'Synthetic workflow rejection'},status:400};
    throw error;
  }
}
