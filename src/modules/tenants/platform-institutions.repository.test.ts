import * as supabase from '../../config/supabase';
import { PlatformInstitutionsRepository } from './platform-institutions.repository';

afterEach(() => jest.restoreAllMocks());

describe('platform dependency boundary', () => {
  it.each<[string, number, number]>([
    ['PT403', 403, 403], ['PT404', 404, 404], ['PT409', 409, 409], ['08006', 500, 503],
    ['22023', 400, 400], ['PGRST202', 404, 503], ['42703', 400, 503], ['XX000', 400, 500],
  ])('maps %s without returning database details', async (code, upstreamStatus, expectedStatus) => {
    const client = { rpc: async () => ({ data: null, error: { code, message: 'private SQL credentials details' }, status: upstreamStatus }) };
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    const operation = new PlatformInstitutionsRepository().mutate('server-actor', 'create', 'synthetic-key', 'server-request', { name: 'Synthetic', slug: 'synthetic' });
    await expect(operation).rejects.toMatchObject({ statusCode: expectedStatus });
    await expect(operation).rejects.not.toHaveProperty('message', 'private SQL credentials details');
  });

  it('does not accept a result for a different institution', async () => {
    const client = { rpc: async () => ({ data: { id: '99999999-9999-9999-9999-999999999999', name: 'Synthetic', slug: 'synthetic', operationalStatus: 'active', version: 1, createdAt: 'synthetic', updatedAt: 'synthetic' }, error: null, status: 200 }) };
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    await expect(new PlatformInstitutionsRepository().mutate('actor', 'suspend', 'key', 'request', { id: '11111111-1111-1111-1111-111111111111', expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 502 });
  });
});
