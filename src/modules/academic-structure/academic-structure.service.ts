import { HttpError } from '../../shared/http-error';
import { AppUser } from '../../shared/types';
import { canManageTenant } from '../../shared/roles';
import { AcademicAccess } from '../../shared/academic-access';
import { Pagination } from '../../shared/pagination';
import { UsersRepository } from '../users/users.repository';
import { CoursesRepository } from '../courses/courses.repository';
import { AcademicStructureRepository, StructureRecord } from './academic-structure.repository';
import { Resource, validatePeriodDates } from './academic-structure.schemas';

export class AcademicStructureService {
  private readonly repository = new AcademicStructureRepository();
  private readonly access = new AcademicAccess();
  private manager(user: AppUser, tenantId: string) {
    if (user.tenantId !== tenantId || !canManageTenant(user.role)) throw new HttpError(403, 'FORBIDDEN', 'Gestao academica nao permitida.');
  }
  private async authorized(resource: Resource, user: AppUser, record: StructureRecord) {
    if (user.tenantId !== record.tenantId) throw new HttpError(404, 'ACADEMIC_RECORD_NOT_FOUND', 'Registro nao encontrado.');
    if (resource === 'offerings') await this.access.require(user, record.tenantId, record.id);
    if (resource === 'enrollments' && user.role === 'student') {
      if (record.studentId !== user.id) throw new HttpError(404, 'ENROLLMENT_NOT_FOUND', 'Matricula nao encontrada.');
      return record;
    }
    if (resource === 'enrollments' || resource === 'teaching-assignments') await this.access.require(user, record.tenantId, String(record.classId));
    return record;
  }
  async list(resource: Resource, user: AppUser, tenantId: string, filters: Record<string, string>, pagination: Pagination) {
    if (resource === 'enrollments' && user.role === 'student') {
      if (filters.studentId && filters.studentId !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Acesso a matricula de outro aluno nao permitido.');
      filters = { ...filters, studentId: user.id };
    }
    const scoped = ['offerings', 'enrollments', 'teaching-assignments'].includes(resource) && !(resource === 'enrollments' && user.role === 'student') ? await this.access.classIds(user, tenantId) : undefined;
    if (filters.classId && scoped && !scoped.includes(filters.classId)) throw new HttpError(404, 'CLASS_NOT_FOUND', 'Turma nao encontrada.');
    return this.repository.list(resource, tenantId, filters, pagination, scoped);
  }
  async find(resource: Resource, user: AppUser, tenantId: string, id: string) {
    return this.authorized(resource, user, await this.repository.find(resource, tenantId, id));
  }
  async create(resource: Resource, user: AppUser, tenantId: string, input: Record<string, unknown>) {
    this.manager(user, tenantId);
    await this.validate(resource, tenantId, input);
    let duplicates: StructureRecord[] = [];
    if (resource === 'academic-periods' || resource === 'subjects') duplicates = await this.repository.all(resource, tenantId, { code: String(input.code) });
    if (resource === 'enrollments') duplicates = await this.repository.all(resource, tenantId, { classId: String(input.classId), studentId: String(input.studentId) });
    if (resource === 'teaching-assignments') duplicates = await this.repository.all(resource, tenantId, { classId: String(input.classId), teacherId: String(input.teacherId) });
    if (duplicates.length) throw new HttpError(409, 'ACADEMIC_DUPLICATE', 'Vinculo ou codigo academico ja existente.');
    return this.repository.create(resource, tenantId, input);
  }
  async update(resource: Resource, user: AppUser, tenantId: string, id: string, input: Record<string, unknown>) {
    this.manager(user, tenantId);
    const existing = await this.repository.find(resource, tenantId, id);
    const merged = { ...existing, ...input };
    await this.validate(resource, tenantId, merged);
    if (resource === 'subjects' && input.courseId && input.courseId !== existing.courseId) throw new HttpError(409, 'ACADEMIC_LINK_IMMUTABLE', 'Crie outra disciplina para mudar o curso.');
    if (resource === 'teaching-assignments' && existing.isPrimary && input.status === 'inactive') throw new HttpError(409, 'PRIMARY_TEACHER_REQUIRED', 'Reatribua o docente principal na turma.');
    return this.repository.update(resource, tenantId, id, input);
  }
  async history(user: AppUser, tenantId: string, id: string) {
    await this.find('enrollments', user, tenantId, id);
    return { data: await this.repository.history(tenantId, id) };
  }
  private async validate(resource: Resource, tenantId: string, input: Record<string, unknown>) {
    if (resource === 'academic-periods') validatePeriodDates(input);
    if (resource === 'subjects' || resource === 'offerings') await new CoursesRepository().findById({ tenantId, id: String(input.courseId) });
    if (resource === 'offerings') {
      const subject = await this.repository.find('subjects', tenantId, String(input.subjectId));
      await this.repository.find('academic-periods', tenantId, String(input.periodId));
      if (subject.courseId !== input.courseId) throw new HttpError(409, 'SUBJECT_COURSE_MISMATCH', 'Disciplina nao pertence ao curso da turma.');
      if (input.teacherAuthId) {
        const teacher = await new UsersRepository().findAcademicMember({ tenantId, identifier: String(input.teacherAuthId), role: 'teacher' });
        if (teacher.active === false) throw new HttpError(409, 'MEMBER_INACTIVE', 'Docente institucional inativo.');
      }
    }
    if (resource === 'enrollments' || resource === 'teaching-assignments') {
      const offering = await this.repository.find('offerings', tenantId, String(input.classId));
      const isStudent = resource === 'enrollments';
      if (isStudent && (!offering.subjectId || !offering.periodId)) throw new HttpError(409, 'LEGACY_OFFERING_UNMAPPED', 'Mapeie disciplina e periodo antes da matricula.');
      const member = await new UsersRepository().findAcademicMember({ tenantId, identifier: String(isStudent ? input.studentId : input.teacherId), role: isStudent ? 'student' : 'teacher' });
      if (member.id !== (isStudent ? input.studentId : input.teacherId)) throw new HttpError(404, 'USER_NOT_FOUND', 'Use o identificador institucional.');
      if (input.status === 'active' && member.active === false) throw new HttpError(409, 'MEMBER_INACTIVE', 'Novos vinculos ativos exigem usuario institucional ativo.');
      if (isStudent && input.status === 'active' && offering.status !== 'active') throw new HttpError(409, 'OFFERING_CLOSED', 'Oferta nao aceita matriculas ativas.');
    }
  }
}
