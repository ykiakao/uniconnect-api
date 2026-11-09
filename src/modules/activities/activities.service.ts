import { AcademicAccess } from '../../shared/academic-access';
import { ClassesRepository } from '../classes/classes.repository';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import {
  ActivitiesRepository,
  ActivityResponse,
} from './activities.repository';
import { ActivityInput, ActivityUpdate, activityPayload } from './activities.workflow.schemas';

export class ActivitiesService {
  private readonly activitiesRepository = new ActivitiesRepository();
  private readonly classesRepository = new ClassesRepository();

  async listByClass(params: {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
    pagination: Pagination;
  }) {
    if (params.currentUser.role === 'student') {
      const rows=await this.activitiesRepository.listByClass({...params,studentId:params.currentUser.id});
      return toPaginated({data:rows.activities,total:rows.total,page:params.pagination.page,limit:params.pagination.limit});
    }
    const hasAccess = await this.canAccessClass({
      currentUser: params.currentUser,
      tenantId: params.tenantId,
      classId: params.classId,
    });

    if (!hasAccess) {
      return toPaginated<ActivityResponse>({
        data: [],
        total: 0,
        page: params.pagination.page,
        limit: params.pagination.limit,
      });
    }

    const { activities, total } = await this.activitiesRepository.listByClass({
      tenantId: params.tenantId,
      classId: params.classId,
      pagination: params.pagination,
    });

    return toPaginated<ActivityResponse>({
      data: activities,
      total,
      page: params.pagination.page,
      limit: params.pagination.limit,
    });
  }

  async create(params: ActivityInput & {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
  }) {
    await this.ensureCanManageClassActivities({
      currentUser: params.currentUser,
      tenantId: params.tenantId,
      classId: params.classId,
    });

    const {currentUser,tenantId,classId,...input}=params;
    return this.activitiesRepository.manage(tenantId,currentUser.id,'create',{classId,payload:activityPayload(input)});
  }

  async findById(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    const activity = await this.activitiesRepository.findById({
      tenantId: params.tenantId,
      id: params.id,
    });

    if (params.currentUser.role==='student') {
      const visible=await this.activitiesRepository.visibleToStudent(params.tenantId,params.currentUser.id,activity.classId,{page:1,limit:1,offset:0},activity.id);
      if (!visible.activities.length) throw new HttpError(404,'ACTIVITY_NOT_FOUND','Atividade nao encontrada.');
      return visible.activities[0];
    }

    const hasAccess = await this.canAccessClass({
      currentUser: params.currentUser,
      tenantId: params.tenantId,
      classId: activity.classId,
    });

    if (!hasAccess) {
      throw new HttpError(
        404,
        'ACTIVITY_NOT_FOUND',
        'Atividade nÃ£o encontrada.',
      );
    }

    return activity;
  }

  async update(params: ActivityUpdate & {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    const activity = await this.activitiesRepository.findById({
      tenantId: params.tenantId,
      id: params.id,
    });

    await this.ensureCanManageClassActivities({ currentUser: params.currentUser, tenantId: params.tenantId, classId: activity.classId });
    if (!activity.workflowEnabled) this.ensureCanModifyActivity(params.currentUser, activity);
    if (activity.workflowEnabled && params.expectedVersion===undefined) throw new HttpError(409,'ACTIVITY_VERSION_REQUIRED','Informe a versao atual da atividade.');
    const {currentUser,tenantId,id,...input}=params;
    return this.activitiesRepository.manage(tenantId,currentUser.id,'update',{id,payload:activityPayload(input)});
  }

  async delete(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    const activity = await this.activitiesRepository.findById({
      tenantId: params.tenantId,
      id: params.id,
    });

    await this.ensureCanManageClassActivities({ currentUser: params.currentUser, tenantId: params.tenantId, classId: activity.classId });
    this.ensureCanModifyActivity(params.currentUser, activity);
    await new AcademicAccess().preserveRecords(params.tenantId, ['grades','activity_submissions'].map(table=>({table,field:'activity_id',id:params.id})));
    await this.activitiesRepository.manage(params.tenantId,params.currentUser.id,'delete',{id:params.id});
  }

  async transition(params:{currentUser:AppUser;tenantId:string;id:string;expectedVersion:number},operation:'publish'|'close') {
    const activity=await this.activitiesRepository.findById({tenantId:params.tenantId,id:params.id});
    await this.ensureCanManageClassActivities({...params,classId:activity.classId});
    if (operation==='publish'&&params.currentUser.role!=='teacher') throw new HttpError(403,'FORBIDDEN','Somente docente atribuido pode publicar.');
    return this.activitiesRepository.manage(params.tenantId,params.currentUser.id,operation,{id:params.id,payload:{expected_version:params.expectedVersion}});
  }

  private async ensureCanManageClassActivities(params: {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
  }) {
    if (canManageTenant(params.currentUser.role)) {
      await this.classesRepository.findById({
        tenantId: params.tenantId,
        id: params.classId,
      });
      return;
    }

    if (params.currentUser.role === 'teacher') {
      await new AcademicAccess().require(params.currentUser, params.tenantId, params.classId);
      return;
    }

    throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
  }

  private async canAccessClass(params: {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
  }) {
    await this.classesRepository.findById({ tenantId: params.tenantId, id: params.classId });
    return new AcademicAccess().canRead(params.currentUser, params.tenantId, params.classId);
  }

  private ensureCanModifyActivity(user: AppUser, activity: ActivityResponse) {
    if (canManageTenant(user.role)) return;

    if (user.role === 'teacher' && activity.createdBy === user.authUserId) {
      return;
    }

    throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
  }
}
