import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import { CoursesRepository } from '../courses/courses.repository';
import { ClassesRepository, ClassResponse } from './classes.repository';
import { AcademicAccess } from '../../shared/academic-access';
import { UsersRepository } from '../users/users.repository';

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

    const classIds = await new AcademicAccess().classIds(params.currentUser, params.tenantId);
    if (classIds?.length === 0) {
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
      classIds,
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
      teacherId: await this.validateTeacher(params.tenantId, params.teacherId),
    });
  }

  async findById(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    const classItem = await this.classesRepository.findById({
      tenantId: params.tenantId,
      id: params.id,
    });
    await new AcademicAccess().require(params.currentUser, params.tenantId, classItem.id);
    return classItem;
  }

  async update(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
    name: string;
    teacherId?: string;
  }) {
    this.ensureCanManageClasses(params.currentUser);
    const existing = await this.classesRepository.findById({ tenantId: params.tenantId, id: params.id });

    return this.classesRepository.update({
      tenantId: params.tenantId,
      id: params.id,
      name: params.name,
      teacherId: await this.validateTeacher(params.tenantId, params.teacherId ?? existing.teacherId),
    });
  }

  async delete(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    this.ensureCanManageClasses(params.currentUser);
    await new AcademicAccess().preserveRecords(params.tenantId, ['activities', 'enrollments', 'teaching_assignments'].map(table => ({ table, field: 'class_id', id: params.id })));
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

  private async validateTeacher(tenantId: string, identifier?: string) {
    if (identifier === undefined) return undefined;
    const teacher = await new UsersRepository().findAcademicMember({ tenantId, identifier, role: 'teacher' });
    if (teacher.active === false) throw new HttpError(409, 'MEMBER_INACTIVE', 'Docente institucional inativo.');
    return teacher.authUserId;
  }
}
