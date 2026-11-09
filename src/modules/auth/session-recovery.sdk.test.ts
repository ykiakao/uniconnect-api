import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { SessionService } from './session.service';
import { RecoveryService } from './recovery.service';
import { env } from '../../config/env';

const firstId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const secondId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const issuedAt = Math.floor(Date.now() / 1000);
function identity(id: string): User {
  return { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.invalid`, email_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} };
}
function jwt(id: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, exp: issuedAt + 3600, iat: issuedAt, aud: 'authenticated' })}.synthetic-signature`;
}
function providerFixture() {
  const requests: { client: number; path: string; method: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  const clients: SupabaseClient[] = [];
  const createClientForOperation = () => {
    const client = clients.length;
    const fetch: typeof globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      const method = options?.method ?? 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      const authorization = new Headers(options?.headers).get('authorization');
      requests.push({ client, path: `${url.pathname}${url.search}`, method, body, authorization });
      const id = body.token_hash === 'second-proof' || body.refresh_token === 'second-refresh' ? secondId :
        authorization === `Bearer ${jwt(secondId)}` ? secondId : firstId;
      const user = identity(id);
      if (url.pathname.endsWith('/recover')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/user')) return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/verify') || url.pathname.endsWith('/token')) return new Response(JSON.stringify({ user, access_token: jwt(id), refresh_token: `rotated-${id}`, expires_in: 3600, token_type: 'bearer' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error('Unexpected synthetic SDK request');
    };
    const result = createClient('https://offline.example.invalid', 'synthetic-anon', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { transport: WebSocket as never } });
    clients.push(result);
    return result;
  };
  return { createClientForOperation, requests, clients };
}
describe('official Supabase SDK against in-process synthetic fetch only', () => {
  it('preserves the local integration provider refresh rejection code through the official SDK error decoder', async () => {
    const { createSyntheticAuth, syntheticAuthResponseHeaders } = require('../../../scripts/lib/stage9-local.cjs');
    const provider = createSyntheticAuth({ db: { query: async () => ({ rows: [] }) }, secret: 'offline-synthetic-secret', defaultPassword: 'Synthetic123!', serviceKey: 'synthetic-service' });
    const account = await provider.createAuth('offline-refresh@example.invalid');
    const fetch: typeof globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      const result = await provider.handle({ path: url.pathname, method: options?.method ?? 'GET',
        body: options?.body ? JSON.parse(String(options.body)) : {}, query: url.searchParams,
        bearer: new Headers(options?.headers).get('authorization')?.replace(/^Bearer /, '') });
      return new Response(result.status === 204 ? null : JSON.stringify(result.data), { status: result.status, headers: syntheticAuthResponseHeaders });
    };
    const fresh = () => createClient('https://offline.example.invalid', 'synthetic-anon', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { transport: WebSocket as never } });
    const oldRefresh = provider.refreshTokenFor(account.id);
    expect((await fresh().auth.refreshSession({ refresh_token: oldRefresh })).error).toBeNull();
    const reused = await fresh().auth.refreshSession({ refresh_token: oldRefresh });
    expect(reused.error?.code).toBe('refresh_token_already_used');
    expect(reused.data.session).toBeNull();
  });
  it('sends refresh_token grant with JSON proof and verifies the new bearer before current authorization', async () => {
    const f = providerFixture();
    const original = [...env.PLATFORM_ADMIN_AUTH_USER_IDS];
    try {
      env.PLATFORM_ADMIN_AUTH_USER_IDS = [firstId];
      const service = new SessionService(f.createClientForOperation);
      const result = await service.refreshPlatform('synthetic-old-refresh');
      expect(result.authorization.authUserId).toBe(firstId);
      expect(f.requests).toEqual([
        expect.objectContaining({ path: '/auth/v1/token?grant_type=refresh_token', method: 'POST', body: { refresh_token: 'synthetic-old-refresh' } }),
        expect.objectContaining({ path: '/auth/v1/user', method: 'GET', authorization: `Bearer ${result.accessToken}` }),
      ]);
      expect(f.requests[0].path).not.toContain('synthetic-old-refresh');
    } finally { env.PLATFORM_ADMIN_AUTH_USER_IDS = original; }
  });
  it('sends server-only recovery redirect and recovery/invite proofs with SDK session-bound password updates and global logout', async () => {
    const f = providerFixture();
    const service = new RecoveryService(f.createClientForOperation, () => 'https://frontend.example.invalid/reset');
    await service.requestRecovery('synthetic@example.invalid');
    await service.changePassword({ tokenHash: 'first-proof', newPassword: 'Synthetic123!' }, 'recovery');
    await service.changePassword({ tokenHash: 'second-proof', newPassword: 'Synthetic456!' }, 'invite');
    expect(f.clients).toHaveLength(3);
    expect(f.requests[0]).toMatchObject({ path: '/auth/v1/recover?redirect_to=https%3A%2F%2Ffrontend.example.invalid%2Freset', method: 'POST', body: { email: 'synthetic@example.invalid' } });
    for (const [client, id, type, tokenHash, password] of [[1, firstId, 'recovery', 'first-proof', 'Synthetic123!'], [2, secondId, 'invite', 'second-proof', 'Synthetic456!']] as const) {
      const requests = f.requests.filter(item => item.client === client);
      expect(requests).toEqual([
        expect.objectContaining({ path: '/auth/v1/verify', method: 'POST', body: expect.objectContaining({ token_hash: tokenHash, type }) }),
        expect.objectContaining({ path: '/auth/v1/user', method: 'GET', authorization: `Bearer ${jwt(id)}` }),
        expect.objectContaining({ path: '/auth/v1/user', method: 'PUT', body: expect.objectContaining({ password }), authorization: `Bearer ${jwt(id)}` }),
        expect.objectContaining({ path: '/auth/v1/logout?scope=global', method: 'POST', authorization: `Bearer ${jwt(id)}` }),
      ]);
      expect((await f.clients[client].auth.getSession()).data.session).toBeNull();
    }
    expect(f.requests.some(item => /admin/.test(item.path))).toBe(false);
  });
});
