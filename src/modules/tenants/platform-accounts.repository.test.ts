import { randomUUID } from 'node:crypto';
import * as supabase from '../../config/supabase';
import { PlatformAccountsRepository } from './platform-accounts.repository';

type RpcResult = { data: unknown; error: { code: string; message: string; details: string; hint: string } | null; count: null; status: number; statusText: string };
type Rpc = (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
afterEach(() => jest.restoreAllMocks());
it.each([
  ['PGRST202', 'PRIVATE schema missing', 503, 'DATABASE_MIGRATION_REQUIRED'],
  ['PT404', 'PROVISION_NOT_FOUND', 404, 'PROVISION_NOT_FOUND'],
  ['PT404', 'INSTITUTION_NOT_FOUND', 404, 'TENANT_NOT_FOUND'],
  ['PT409', 'ACCOUNT_AUTH_UNCONFIRMED', 409, 'ACCOUNT_AUTH_UNCONFIRMED'],
  ['PT409', 'PRIVATE SQL detail', 409, 'PLATFORM_CONFLICT'],
  ['PT403', 'PRIVATE tenant detail', 403, 'TENANT_SUSPENDED'],
  ['42501', 'PRIVATE credentials', 403, 'FORBIDDEN'],
  ['22023', 'PRIVATE payload', 400, 'VALIDATION_ERROR'],
  ['XX000', 'PRIVATE internals', 500, 'DATABASE_QUERY_FAILED'],
  ['08006', 'PRIVATE connection', 503, 'DEPENDENCY_UNAVAILABLE'],
])('sanitizes RPC %s without success fallback', async (code, message, statusCode, publicCode) => {
  const rpc: Rpc = async () => ({ data: null, error: { code, message, details: '', hint: '' }, count: null, status: 400, statusText: 'Bad Request' });
  jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ rpc } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
  const result = new PlatformAccountsRepository().call(randomUUID(), 'prepare_provision', randomUUID(), randomUUID(), { institutionId: randomUUID(), provisionId: randomUUID() });
  await expect(result).rejects.toMatchObject({ statusCode, code: publicCode });
  await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining('PRIVATE'));
});
