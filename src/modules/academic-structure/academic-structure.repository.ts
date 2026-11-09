import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { checkQueryError, requireRows, requireCount } from '../../shared/supabase-errors';
import { Resource } from './academic-structure.schemas';

const tables: Record<Resource, string> = { 'academic-periods': 'academic_periods', subjects: 'subjects', offerings: 'classes', enrollments: 'enrollments', 'teaching-assignments': 'teaching_assignments' };
const columns: Record<Resource, string> = {
  'academic-periods': 'id,tenant_id,code,name,start_date,end_date,status', subjects: 'id,tenant_id,course_id,code,name,status',
  offerings: 'id,tenant_id,course_id,subject_id,academic_period_id,name,academic_status,teacher_id',
  enrollments: 'id,tenant_id,class_id,student_id,status,created_at,updated_at',
  'teaching-assignments': 'id,tenant_id,class_id,teacher_id,status,is_primary',
};
const aliases: Record<string, string> = { periodId: 'academic_period_id', teacherAuthId: 'teacher_id' };
export type StructureRecord = { id: string; tenantId: string; [key: string]: unknown };
export function toStructureRecord(value: unknown): StructureRecord {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !('tenant_id' in value) || typeof value.tenant_id !== 'string') {
    throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Registro academico invalido.');
  }
  const row = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const field = key === 'academic_period_id' ? 'periodId' : key === 'academic_status' ? 'status' : key.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
    output[field] = value;
  }
  return output as StructureRecord;
}
function payload(resource: Resource, input: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) result[key === 'status' && resource === 'offerings' ? 'academic_status' : aliases[key] ?? key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase())] = value;
  return result;
}
export class AcademicStructureRepository {
  private readonly db = createSupabaseAdminClient();
  async list(resource: Resource, tenantId: string, filters: Record<string, string>, pagination: Pagination, classIds?: string[]) {
    let query = this.db.from(tables[resource]).select(columns[resource], { count: 'exact' }).eq('tenant_id', tenantId).order('id');
    for (const [field, value] of Object.entries(payload(resource, filters))) query = query.eq(field, value);
    if (classIds) query = query.in(resource === 'offerings' ? 'id' : 'class_id', classIds);
    const { data, error, count, status } = await query.range(pagination.offset, pagination.offset + pagination.limit - 1);
    checkQueryError(error, status);
    return toPaginated({ data: requireRows(data).map(row => toStructureRecord(row)), total: requireCount(count), page: pagination.page, limit: pagination.limit });
  }
  async all(resource: Resource, tenantId: string, filters: Record<string, string> = {}) {
    let query = this.db.from(tables[resource]).select(columns[resource]).eq('tenant_id', tenantId).order('id');
    for (const [field, value] of Object.entries(payload(resource, filters))) query = query.eq(field, value);
    const { data, error, status } = await query;
    checkQueryError(error, status); return requireRows(data).map(row => toStructureRecord(row));
  }
  async find(resource: Resource, tenantId: string, id: string) {
    const { data, error, status } = await this.db.from(tables[resource]).select(columns[resource]).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    checkQueryError(error, status);
    if (!data) throw new HttpError(404, 'ACADEMIC_RECORD_NOT_FOUND', 'Registro academico nao encontrado.');
    return toStructureRecord(data);
  }
  async create(resource: Resource, tenantId: string, input: Record<string, unknown>) {
    const { data, error, status } = await this.db.from(tables[resource]).insert({ ...payload(resource, input), tenant_id: tenantId }).select(columns[resource]).single();
    checkQueryError(error, status);
    if (!data) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta academica invalida.');
    return toStructureRecord(data);
  }
  async update(resource: Resource, tenantId: string, id: string, input: Record<string, unknown>) {
    const { data, error, status } = await this.db.from(tables[resource]).update(payload(resource, input)).eq('tenant_id', tenantId).eq('id', id).select(columns[resource]).maybeSingle();
    checkQueryError(error, status);
    if (!data) throw new HttpError(404, 'ACADEMIC_RECORD_NOT_FOUND', 'Registro academico nao encontrado.');
    return toStructureRecord(data);
  }
  async history(tenantId: string, enrollmentId: string) {
    const { data, error, status } = await this.db.from('enrollment_status_history').select('id,tenant_id,enrollment_id,status,changed_at').eq('tenant_id', tenantId).eq('enrollment_id', enrollmentId).order('changed_at');
    checkQueryError(error, status); return requireRows(data).map(row => toStructureRecord(row));
  }
}
