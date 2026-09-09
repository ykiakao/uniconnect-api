import { ClassesRepository } from '../classes/classes.repository';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import {
  ActivitiesRepository,
  ActivityResponse,
} from './activities.repository';

export class ActivitiesService {
  private readonly activitiesRepository = new ActivitiesRepository();
  private readonly classesRepository = new ClassesRepository();

  async listByClass(params: {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
    pagination: Pagination;
  }) {
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

  async create(params: {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
    title: string;
    description?: string;
    dueDate?: string;
    type: string;
  }) {
    await this.ensureCanManageClassActivities({
      currentUser: params.currentUser,
      tenantId: params.tenantId,
      classId: params.classId,
    });

    return this.activitiesRepository.create({
      tenantId: params.tenantId,
      classId: params.classId,
      title: params.title,
      description: params.description,
      dueDate: params.dueDate,
      type: params.type,
      createdBy: params.currentUser.authUserId,
    });
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

  async update(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
    title?: string;
    description?: string;
    dueDate?: string;
    type?: string;
  }) {
    const activity = await this.activitiesRepository.findById({
      tenantId: params.tenantId,
      id: params.id,
    });

    this.ensureCanModifyActivity(params.currentUser, activity);

    return this.activitiesRepository.update(params);
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

    this.ensureCanModifyActivity(params.currentUser, activity);
    await this.activitiesRepository.delete({
      tenantId: params.tenantId,
      id: params.id,
    });
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
      await this.classesRepository.findById({
        tenantId: params.tenantId,
        id: params.classId,
        teacherAuthUserId: params.currentUser.authUserId,
      });
      return;
    }

    throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
  }

  private async canAccessClass(params: {
    currentUser: AppUser;
    tenantId: string;
    classId: string;
  }) {
    if (params.currentUser.role === 'student') return false;

    await this.ensureCanManageClassActivities(params);
    return true;
  }

  private ensureCanModifyActivity(user: AppUser, activity: ActivityResponse) {
    if (canManageTenant(user.role)) return;

    if (user.role === 'teacher' && activity.createdBy === user.authUserId) {
      return;
    }

    throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
  }
}
