import { createSupabaseAdminClient } from '../config/supabase';
import { checkQueryError, requireRows, requireCount } from './supabase-errors';
import { canManageTenant } from './roles';
import { AppUser } from './types';
import { HttpError } from './http-error';

export class AcademicAccess {
  private readonly db = createSupabaseAdminClient();
  async classIds(user: AppUser, tenantId: string): Promise<string[] | undefined> {
    if (user.tenantId !== tenantId) throw new HttpError(403, 'FORBIDDEN', 'Contexto institucional invalido.');
    if (canManageTenant(user.role)) return undefined;
    const student = user.role === 'student';
    const { data, error, status } = await this.db.from(student ? 'enrollments' : 'teaching_assignments')
      .select('class_id').eq('tenant_id', tenantId).eq(student ? 'student_id' : 'teacher_id', user.id)
      .in('status', student ? ['active', 'completed'] : ['active']);
    checkQueryError(error, status); return [...new Set(requireRows(data).map(row => row.class_id as string))];
  }
  async canRead(user: AppUser, tenantId: string, classId: string) {
    const ids = await this.classIds(user, tenantId);
    return ids === undefined || ids.includes(classId);
  }
  async require(user: AppUser, tenantId: string, classId: string) {
    if (!await this.canRead(user, tenantId, classId)) throw new HttpError(404, 'CLASS_NOT_FOUND', 'Turma nao encontrada.');
  }
  async requireStudent(tenantId: string, studentId: string, classId: string) {
    const { data, error, status } = await this.db.from('enrollments').select('id').eq('tenant_id', tenantId)
      .eq('student_id', studentId).eq('class_id', classId).in('status', ['active', 'completed']);
    checkQueryError(error, status);
    if (requireRows(data).length !== 1) throw new HttpError(409, 'STUDENT_NOT_ENROLLED', 'Aluno sem matricula elegivel nesta turma.');
  }
  async preserveRecords(tenantId: string, dependencies: Array<{ table: string; field: string; id: string }>) {
    for (const dependency of dependencies) {
      const { count, error, status } = await this.db.from(dependency.table).select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq(dependency.field, dependency.id);
      checkQueryError(error, status);
      if (requireCount(count) > 0) throw new HttpError(409, 'ACADEMIC_HISTORY_PROTECTED', 'O registro possui historico academico e nao pode ser excluido.');
    }
  }
}
