import { AcademicAccess } from '../../shared/academic-access';
import { UsersRepository } from '../users/users.repository';
import { ActivitiesRepository } from '../activities/activities.repository';
import { ClassesRepository } from '../classes/classes.repository';
import { HttpError } from '../../shared/http-error';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import { GradesRepository } from './grades.repository';
import { SubmissionsRepository } from '../activities/activities.submissions.repository';

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
    const activity = await this.ensureCanManageActivityGrades(params);
    const student = await new UsersRepository().findAcademicMember({ tenantId: params.tenantId, identifier: params.studentId, role: 'student' });
    await new AcademicAccess().requireStudent(params.tenantId, student.id, activity.classId);
    if (activity.state==='draft') throw new HttpError(409,'ACTIVITY_NOT_PUBLISHED','Publique a atividade antes de registrar notas.');
    if (await new SubmissionsRepository().own(params.tenantId,activity.id,student.id)) throw new HttpError(409,'USE_SUBMISSION_REVIEW','Avalie a entrega pelo fluxo de correcao.');
    if (activity.workflowEnabled) {
      const grade=await new SubmissionsRepository().recordManual(params.tenantId,params.currentUser.id,activity.id,student.id,params.grade,params.feedback??null);
      return {studentId:student.authUserId,grade:grade.grade,feedback:grade.feedback??undefined,gradedAt:grade.graded_at};
    }

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
          publishedOnly: true,
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
        classIds: params.currentUser.role === 'teacher' ? await new AcademicAccess().classIds(params.currentUser, params.tenantId) : undefined,
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

    if (!canManageTenant(params.currentUser.role)) {
      if (params.currentUser.role !== 'teacher') {
        throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
      }
      await new AcademicAccess().require(params.currentUser, params.tenantId, activity.classId);
    }
    if (activity.assessment?.category === 'exam') {
      throw new HttpError(409, 'USE_EXAM_GRADES', 'Use o fluxo de notas de prova.');
    }
    return activity;
  }
}
