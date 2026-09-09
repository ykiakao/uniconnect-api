import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import { CoursesRepository } from '../courses/courses.repository';
import { ClassesRepository, ClassResponse } from './classes.repository';

export class ClassesService {
  private readonly classesRepository = new ClassesRepository();
  private readonly coursesRepository = new CoursesRepository();

  async listByCourse(params: {
    currentUser: AppUser;
    tenantId: string;
    courseId: string;
    pagination: Pagination;
  }) {
    const course = await this.coursesRepository.findById({
      tenantId: params.tenantId,
      id: params.courseId,
    });

    if (
      params.currentUser.role === 'student' &&
      course.name !== params.currentUser.course
    ) {
      return toPaginated<ClassResponse>({
        data: [],
        total: 0,
        page: params.pagination.page,
        limit: params.pagination.limit,
      });
    }

    const { classes, total } = await this.classesRepository.listByCourse({
      tenantId: params.tenantId,
      courseId: params.courseId,
      teacherAuthUserId:
        params.currentUser.role === 'teacher'
          ? params.currentUser.authUserId
          : undefined,
      pagination: params.pagination,
    });

    return toPaginated<ClassResponse>({
      data: classes,
      total,
      page: params.pagination.page,
      limit: params.pagination.limit,
    });
  }

  async create(params: {
    currentUser: AppUser;
    tenantId: string;
    courseId: string;
    name: string;
    teacherId?: string;
  }) {
    this.ensureCanManageClasses(params.currentUser);
    await this.coursesRepository.findById({
      tenantId: params.tenantId,
      id: params.courseId,
    });

    return this.classesRepository.create({
      tenantId: params.tenantId,
      courseId: params.courseId,
      name: params.name,
      teacherId: params.teacherId,
    });
  }

  async findById(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    if (params.currentUser.role === 'student') {
      const classItem = await this.classesRepository.findById({
        tenantId: params.tenantId,
        id: params.id,
      });
      const course = await this.coursesRepository.findById({
        tenantId: params.tenantId,
        id: classItem.courseId,
      });

      if (course.name !== params.currentUser.course) {
        throw new HttpError(404, 'CLASS_NOT_FOUND', 'Turma não encontrada.');
      }

      return classItem;
    }

    return this.classesRepository.findById({
      tenantId: params.tenantId,
      id: params.id,
      teacherAuthUserId:
        params.currentUser.role === 'teacher'
          ? params.currentUser.authUserId
          : undefined,
    });
  }

  async update(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
    name: string;
    teacherId?: string;
  }) {
    this.ensureCanManageClasses(params.currentUser);

    return this.classesRepository.update({
      tenantId: params.tenantId,
      id: params.id,
      name: params.name,
      teacherId: params.teacherId,
    });
  }

  async delete(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    this.ensureCanManageClasses(params.currentUser);
    await this.classesRepository.delete({
      tenantId: params.tenantId,
      id: params.id,
    });
  }

  private ensureCanManageClasses(user: AppUser) {
    if (!canManageTenant(user.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso não permitido');
    }
  }
}
