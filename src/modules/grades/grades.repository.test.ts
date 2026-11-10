import * as supabase from '../../config/supabase';
import { UsersRepository } from '../users/users.repository';
import { GradesRepository } from './grades.repository';

describe('grade database write failures', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['42P10', 503, 'DATABASE_MIGRATION_REQUIRED'],
    ['23503', 409, 'GRADE_INTEGRITY_CONFLICT'],
    ['23514', 409, 'GRADE_INTEGRITY_CONFLICT'],
    ['08006', 503, 'DEPENDENCY_UNAVAILABLE'],
  ])('handles PostgreSQL %s without reintroducing unsafe insert fallback', async (code, statusCode, expectedCode) => {
    const query = { upsert: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { code, message: 'private details' } }) };
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ from: () => query } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    jest.spyOn(UsersRepository.prototype, 'findAcademicMember').mockResolvedValue({
      id: 'student', authUserId: 'auth-student', tenantId: 'tenant', role: 'student', name: 'Synthetic', email: 'x@example.invalid',
    });
    await expect(new GradesRepository().upsert({ tenantId: 'tenant', activityId: 'activity', studentId: 'student', grade: 7, gradedBy: 'teacher' }))
      .rejects.toMatchObject({ statusCode, code: expectedCode });
    expect(query.upsert).toHaveBeenCalledTimes(1);
    expect(query.upsert.mock.calls[0][1]).toEqual({ onConflict: 'tenant_id,activity_id,student_id' });
  });
});
