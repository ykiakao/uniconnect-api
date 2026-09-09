import { ActivitiesRepository } from '../activities/activities.repository';
import { ClassesRepository } from '../classes/classes.repository';
import { HttpError } from '../../shared/http-error';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import { GradesRepository } from './grades.repository';

export class GradesService {
  private readonly activitiesRepository = new ActivitiesRepository();
  private readonly classesRepository = new ClassesRepository();
  private readonly gradesRepository = new GradesRepository();

  async listByActivity(params: {
    currentUser: AppUser;
    tenantId: string;
    activityId: string;
  }) {
    await this.ensureCanManageActivityGrades(params);

    return {
      data: await this.gradesRepository.listByActivity({
        tenantId: params.tenantId,
        activityId: params.activityId,
      }),
    };
  }

  async upsert(params: {
    currentUser: AppUser;
    tenantId: string;
    activityId: string;
    studentId: string;
    grade: number;
    feedback?: string;
  }) {
    await this.ensureCanManageActivityGrades(params);

    return this.gradesRepository.upsert({
      tenantId: params.tenantId,
      activityId: params.activityId,
      studentId: params.studentId,
      grade: params.grade,
      feedback: params.feedback,
      gradedBy: params.currentUser.authUserId,
    });
  }

  async listByStudent(params: {
    currentUser: AppUser;
    tenantId: string;
    studentId: string;
  }) {
    const teacherAuthUserId =
      params.currentUser.role === 'teacher'
        ? params.currentUser.authUserId
        : undefined;

    if (params.currentUser.role === 'student') {
      if (
        params.currentUser.authUserId !== params.studentId &&
        params.currentUser.id !== params.studentId
      ) {
        throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
      }

      return {
        data: await this.gradesRepository.listByStudent({
          tenantId: params.tenantId,
          studentId: params.studentId,
        }),
      };
    }

    if (!canManageTenant(params.currentUser.role) && !teacherAuthUserId) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
    }

    return {
      data: await this.gradesRepository.listByStudent({
        tenantId: params.tenantId,
        studentId: params.studentId,
        teacherAuthUserId,
      }),
    };
  }

  private async ensureCanManageActivityGrades(params: {
    currentUser: AppUser;
    tenantId: string;
    activityId: string;
  }) {
    const activity = await this.activitiesRepository.findById({
      tenantId: params.tenantId,
      id: params.activityId,
    });

    if (canManageTenant(params.currentUser.role)) return;

    if (params.currentUser.role !== 'teacher') {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
    }

    await this.classesRepository.findById({
      tenantId: params.tenantId,
      id: activity.classId,
      teacherAuthUserId: params.currentUser.authUserId,
    });
  }
}
