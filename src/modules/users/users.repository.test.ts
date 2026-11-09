import * as supabase from '../../config/supabase';
import { UsersRepository } from './users.repository';

describe('membership and role database errors', () => {
  afterEach(() => jest.restoreAllMocks());

  function withDatabaseError(code: string) {
    const result = { data: null, error: { code, message: 'private database details' } };
    const query = {
      select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue(result),
      maybeSingle: jest.fn().mockResolvedValue(result),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ from: () => query, rpc: async () => result } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    return new UsersRepository();
  }

  it('returns not found for PostgreSQL invalid UUID errors', async () => {
    const repository = withDatabaseError('22P02');
    await expect(repository.findAcademicMember({ tenantId: 'synthetic', identifier: 'invalid', role: 'student' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'STUDENT_NOT_FOUND' });
  });

  it('fails closed on database lookup failures', async () => {
    const repository = withDatabaseError('08006');
    await expect(repository.findAcademicMember({ tenantId: 'synthetic', identifier: 'id', role: 'teacher' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('maps an invalid membership RPC payload to a sanitized validation error', async () => {
    const repository = withDatabaseError('22023');
    await expect(repository.updateRole({ tenantId: 'synthetic', id: 'id', role: 'teacher', expectedRole: 'student', actorAuthId: 'synthetic-actor' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it.each(['23514', '23503'])('reports a role integrity conflict for %s', async (code) => {
    const repository = withDatabaseError(code);
    await expect(repository.updateRole({ tenantId: 'synthetic', id: 'id', role: 'teacher', expectedRole: 'student', actorAuthId: 'synthetic-actor' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ROLE_INTEGRITY_CONFLICT' });
  });
});
