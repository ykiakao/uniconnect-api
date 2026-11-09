import { AuthApiError, User } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { PlatformAccountsRepository } from './platform-accounts.repository';
import { PlatformAccountsService } from './platform-accounts.service';

const actor = { scope: 'platform' as const, authUserId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };
const institutionId = '11111111-1111-1111-1111-111111111111', id = randomUUID(), requestId = randomUUID();
const input = { email: 'synthetic@example.invalid', name: 'Synthetic' };
const receipt = (state: 'pending' | 'invite_requested' | 'awaiting_confirmation' | 'ready' | 'needs_review' = 'pending') => ({ id, institutionId, state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const prepared = (inviteRequired: boolean, state: Parameters<typeof receipt>[0] = 'invite_requested') => ({ provision: receipt(state), email: input.email, inviteRequired });
const user: User = { id: randomUUID(), email: input.email, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: new Date().toISOString() };
const originalRedirect = env.AUTH_INVITE_REDIRECT_URL;
let repository: PlatformAccountsRepository, call: jest.SpiedFunction<PlatformAccountsRepository['call']>;
let invite: jest.MockedFunction<ReturnType<PlatformAccountsServiceFactory>['auth']['admin']['inviteUserByEmail']>;
type PlatformAccountsServiceFactory = () => { auth: { admin: { inviteUserByEmail: import('@supabase/supabase-js').SupabaseClient['auth']['admin']['inviteUserByEmail'] } } };
let service: PlatformAccountsService;
beforeEach(() => {
  env.AUTH_INVITE_REDIRECT_URL = 'http://127.0.0.1:3000/auth/activate';
  repository = new PlatformAccountsRepository(); call = jest.spyOn(repository, 'call');
  invite = jest.fn(); invite.mockResolvedValue({ data: { user }, error: null });
  service = new PlatformAccountsService(repository, () => ({ auth: { admin: { inviteUserByEmail: invite } } }));
});
afterEach(() => { jest.restoreAllMocks(); env.AUTH_INVITE_REDIRECT_URL = originalRedirect; });

it('persists intent before claiming and uses only server redirect without roles or passwords', async () => {
  const key = randomUUID();
  call.mockResolvedValueOnce(receipt()).mockResolvedValueOnce(prepared(true)).mockResolvedValueOnce(prepared(false, 'awaiting_confirmation'));
  expect((await service.provision(actor, institutionId, input, key, requestId)).state).toBe('awaiting_confirmation');
  expect(call.mock.calls.map(args => args[1])).toEqual(['reserve_provision', 'prepare_provision', 'reconcile_provision']);
  expect(call.mock.calls[0]).toEqual([actor.authUserId, 'reserve_provision', key, requestId, { ...input, institutionId }]);
  expect(invite).toHaveBeenCalledWith(input.email, { redirectTo: env.AUTH_INVITE_REDIRECT_URL });
  expect(call.mock.invocationCallOrder[1]).toBeLessThan(invite.mock.invocationCallOrder[0]);
});
it.each(['ready', 'awaiting_confirmation', 'needs_review'] as const)('does not resend a claimed or preexisting account (%s)', async state => {
  call.mockResolvedValueOnce(prepared(false, state));
  expect((await service.resume(actor, institutionId, id, requestId)).state).toBe(state);
  expect(invite).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(1);
});
it('does not consume an intent if server activation configuration is missing', async () => {
  env.AUTH_INVITE_REDIRECT_URL = undefined;
  await expect(service.provision(actor, institutionId, input, randomUUID(), requestId)).rejects.toMatchObject({ statusCode: 503, code: 'ACCOUNT_INVITE_NOT_CONFIGURED' });
  expect(call).not.toHaveBeenCalled(); expect(invite).not.toHaveBeenCalled();
});
it('reconciles after a provider-side commit followed by a network failure without deleting accounts', async () => {
  call.mockResolvedValueOnce(prepared(true)).mockResolvedValueOnce(prepared(false, 'awaiting_confirmation'));
  invite.mockRejectedValueOnce(new Error('PRIVATE provider failure'));
  await expect(service.resume(actor, institutionId, id, requestId)).rejects.toMatchObject({ statusCode: 503, code: 'ACCOUNT_PROVISIONING_PENDING' });
  expect(call.mock.calls[1][1]).toBe('reconcile_provision');
  call.mockResolvedValueOnce(prepared(false, 'awaiting_confirmation'));
  expect((await service.resume(actor, institutionId, id, requestId)).state).toBe('awaiting_confirmation');
  expect(invite).toHaveBeenCalledTimes(1);
});
it('sanitizes an uncertain checkpoint failure and allows later explicit reconciliation', async () => {
  call.mockResolvedValueOnce(prepared(true)).mockRejectedValueOnce(new Error('PRIVATE SQL details'));
  await expect(service.resume(actor, institutionId, id, requestId)).rejects.toMatchObject({ statusCode: 503, code: 'ACCOUNT_PROVISIONING_PENDING' });
});
it('leaves a claimed account with no Auth result for manual review rather than claiming success', async () => {
  call.mockResolvedValueOnce(prepared(true)).mockResolvedValueOnce(prepared(false, 'needs_review'));
  await expect(service.resume(actor, institutionId, id, requestId)).rejects.toMatchObject({ statusCode: 503, code: 'ACCOUNT_PROVISIONING_PENDING' });
});
it('recovers a concurrent existing-account provider response using SQL identity reconciliation', async () => {
  call.mockResolvedValueOnce(prepared(true)).mockResolvedValueOnce(prepared(false, 'ready'));
  invite.mockResolvedValueOnce({ data: { user: null }, error: new AuthApiError('private provider details', 422, 'email_exists') });
  expect((await service.resume(actor, institutionId, id, requestId)).state).toBe('ready');
});
it('rejects malformed provider identity without exposing it', async () => {
  call.mockResolvedValueOnce(prepared(true)).mockResolvedValueOnce(prepared(false, 'awaiting_confirmation'));
  invite.mockResolvedValueOnce({ data: { user: { ...user, email: 'other@example.invalid' } }, error: null });
  await expect(service.resume(actor, institutionId, id, requestId)).rejects.toMatchObject({ code: 'ACCOUNT_PROVISIONING_PENDING' });
});
it('rejects cross-tenant and mismatched intent responses before sending email', async () => {
  call.mockResolvedValueOnce({ ...prepared(true), provision: { ...receipt(), institutionId: randomUUID() } });
  await expect(service.resume(actor, institutionId, id, requestId)).rejects.toMatchObject({ statusCode: 502 });
  expect(invite).not.toHaveBeenCalled();
  call.mockResolvedValueOnce({ ...prepared(true), provision: { ...receipt(), id: randomUUID() } });
  await expect(service.resume(actor, institutionId, id, requestId)).rejects.toMatchObject({ statusCode: 502 });
});
it('does not infer legacy responsibility or absorb database failures', async () => {
  call.mockResolvedValueOnce(null);
  await expect(service.responsible(actor, institutionId, requestId)).rejects.toMatchObject({ statusCode: 404, code: 'RESPONSIBLE_NOT_DESIGNATED' });
  call.mockRejectedValueOnce(new Error('failed'));
  await expect(service.responsible(actor, institutionId, requestId)).rejects.toThrow('failed');
});
it('requires explicit global authority for account, responsible and audit operations', async () => {
  const unauthorized = { ...actor, authUserId: randomUUID() };
  await expect(service.provision(unauthorized, institutionId, input, randomUUID(), requestId)).rejects.toMatchObject({ statusCode: 403 });
  await expect(service.changeResponsible(unauthorized, institutionId, 'designate_responsible', {}, randomUUID(), requestId)).rejects.toMatchObject({ statusCode: 403 });
  expect(() => service.history(unauthorized, institutionId, { page: 1, limit: 20, offset: 0 })).toThrow();
  expect(call).not.toHaveBeenCalled(); expect(invite).not.toHaveBeenCalled();
});
it('forwards server identity, CAS and idempotency to the atomic responsible RPC', async () => {
  const key = randomUUID(), administratorId = randomUUID();
  call.mockResolvedValueOnce({ institutionId, responsibleUserId: administratorId, version: 1 });
  await service.changeResponsible(actor, institutionId, 'designate_responsible', { administratorId, expectedVersion: 0 }, key, requestId);
  expect(call).toHaveBeenCalledWith(actor.authUserId, 'designate_responsible', key, requestId, { institutionId, administratorId, expectedVersion: 0 });
});
