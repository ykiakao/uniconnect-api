import { createClient } from '@supabase/supabase-js';
import * as supabase from '../../config/supabase';
import { UsersRepository } from './users.repository';

afterEach(() => jest.restoreAllMocks());

it('keeps search, tenant, student role, stable order and pagination in the actual SDK request', async () => {
  const requests: URL[] = [];
  const fetch = jest.fn().mockImplementation(async (input: string | URL | Request) => {
    requests.push(new URL(typeof input === 'string' || input instanceof URL ? input : input.url));
    return new Response(JSON.stringify([{
      id: 'synthetic-student', tenant_id: 'synthetic-tenant', auth_user_id: 'synthetic-auth',
      name: 'Synthetic Student', email: 'synthetic@example.invalid', role: 'student', active: true,
    }]), { status: 200, headers: { 'content-type': 'application/json', 'content-range': '20-20/41' } });
  });
  const client = createClient('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
  });
  jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client);

  const result = await new UsersRepository().list({
    tenantId: 'synthetic-tenant', role: 'student', search: ' Synthetic% ', pagination: { page: 2, limit: 20, offset: 20 },
  });

  expect(requests).toHaveLength(1);
  const url = requests[0];
  expect(url.pathname).toBe('/rest/v1/app_users');
  expect(url.searchParams.get('tenant_id')).toBe('eq.synthetic-tenant');
  expect(url.searchParams.get('role')).toBe('eq.student');
  expect(url.searchParams.get('or')).toBe('(name.ilike.%Synthetic%,email.ilike.%Synthetic%)');
  expect(url.searchParams.get('order')).toBe('name.asc,id.asc');
  expect(url.searchParams.get('offset')).toBe('20');
  expect(url.searchParams.get('limit')).toBe('20');
  expect(result.total).toBe(41);
  expect(result.users[0].id).toBe('synthetic-student');
});
