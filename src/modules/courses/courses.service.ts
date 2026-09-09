import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import { CourseResponse, CoursesRepository } from './courses.repository';

export class CoursesService {
  private readonly repository = new CoursesRepository();

  async list(params: {
    currentUser: AppUser;
    tenantId: string;
    search?: string;
    pagination: Pagination;
  }) {
    const { courses, total } = await this.repository.list({
      tenantId: params.tenantId,
      search: params.search,
      pagination: params.pagination,
    });

    return toPaginated<CourseResponse>({
      data: courses,
      total,
      page: params.pagination.page,
      limit: params.pagination.limit,
    });
  }

  async create(params: {
    currentUser: AppUser;
    tenantId: string;
    name: string;
    description?: string;
  }) {
    this.ensureCanManageCourses(params.currentUser);

    return this.repository.create({
      tenantId: params.tenantId,
      name: params.name,
      description: params.description,
    });
  }

  async findById(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    return this.repository.findByIdWithClasses({
      tenantId: params.tenantId,
      id: params.id,
    });
  }

  async update(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
    name: string;
    description?: string;
  }) {
    this.ensureCanManageCourses(params.currentUser);

    return this.repository.update({
      tenantId: params.tenantId,
      id: params.id,
      name: params.name,
      description: params.description,
    });
  }

  async delete(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
  }) {
    this.ensureCanManageCourses(params.currentUser);
    await this.repository.delete({
      tenantId: params.tenantId,
      id: params.id,
    });
  }

  private ensureCanManageCourses(user: AppUser) {
    if (!canManageTenant(user.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso não permitido');
    }
  }
}
