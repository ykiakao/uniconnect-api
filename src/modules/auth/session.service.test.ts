import { AuthApiError } from '@supabase/supabase-js';
import { SessionService } from './session.service';
import { AuthOperationClient } from './session.client';
import { env } from '../../config/env';
import { HttpError } from '../../shared/http-error';

const principal = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const tenant = { id: 'tenant', slug: 'synthetic' };
const user = { id: 'member', authUserId: principal, tenantId: tenant.id, name: 'Synthetic', email: 'synthetic@example.invalid', role: 'admin' as const, active: true };
const session = { access_token: 'new-jwt', refresh_token: 'new-refresh', expires_at: 2000000000, user: { id: principal } };
function fixture() {
  const auth = { refreshSession: jest.fn().mockResolvedValue({ data: { session, user: session.user }, error: null }),
    getUser: jest.fn().mockResolvedValue({ data: { user: session.user }, error: null }), signOut: jest.fn() };
  const factory = jest.fn(() => ({ auth }) as unknown as AuthOperationClient);
  const repository = { findUserByAuthId: jest.fn().mockResolvedValue(user) };
  const tenants = { requireOperationalById: jest.fn().mockResolvedValue(undefined) };
  const service = new SessionService(factory, repository, tenants);
  return { service, factory, auth, repository, tenants };
}
afterEach(() => jest.restoreAllMocks());
describe('rotated sessions and current authorization', () => {
  it('uses a fresh operation client, verifies the rotated JWT and reads current membership and institution after rotation', async () => {
    const f = fixture();
    const result = await f.service.refreshInstitution({ refreshToken: 'old-refresh', tenant, administrative: false });
    expect(f.auth.refreshSession).toHaveBeenCalledWith({ refresh_token: 'old-refresh' });
    expect(f.auth.getUser).toHaveBeenCalledWith('new-jwt');
    expect(f.repository.findUserByAuthId).toHaveBeenCalledWith({ authUserId: principal, tenantId: tenant.id });
    expect(f.auth.refreshSession.mock.invocationCallOrder[0]).toBeLessThan(f.repository.findUserByAuthId.mock.invocationCallOrder[0]);
    expect(f.auth.refreshSession.mock.invocationCallOrder[0]).toBeLessThan(f.tenants.requireOperationalById.mock.invocationCallOrder[0]);
    expect(result).toEqual({ accessToken: 'new-jwt', refreshToken: 'new-refresh', expiresAt: '2033-05-18T03:33:20.000Z', user: { id: 'member', name: user.name, email: user.email, role: 'admin', tenantSlug: tenant.slug, course: undefined } });
    await f.service.refreshInstitution({ refreshToken: 'another-refresh', tenant });
    expect(f.factory).toHaveBeenCalledTimes(2);
  });
  it.each(['refresh_token_not_found', 'refresh_token_already_used', 'session_expired', 'user_not_found', 'user_banned', 'validation_failed'])('maps provider rejection %s to INVALID_SESSION', async code => {
    const f = fixture();
    f.auth.refreshSession.mockResolvedValue({ data: { session: null, user: null }, error: new AuthApiError('private-provider-detail', 400, code) });
    await expect(f.service.refreshPlatform('bad-refresh')).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_SESSION' });
    expect(f.auth.getUser).not.toHaveBeenCalled();
  });
  it('rejects inconsistent rotated identity and missing session without querying membership', async () => {
    const f = fixture();
    f.auth.getUser.mockResolvedValue({ data: { user: { id: 'different-user' } }, error: null });
    await expect(f.service.refreshInstitution({ refreshToken: 'old', tenant })).rejects.toMatchObject({ statusCode: 502 });
    expect(f.repository.findUserByAuthId).not.toHaveBeenCalled();
    f.auth.refreshSession.mockResolvedValue({ data: { session: null, user: null }, error: null });
    await expect(f.service.refreshPlatform('old')).rejects.toMatchObject({ statusCode: 502 });
  });
  it('uses the current role and denies revoked administrative authority without global logout', async () => {
    const f = fixture();
    f.repository.findUserByAuthId.mockResolvedValue({ ...user, role: 'student' });
    expect((await f.service.refreshInstitution({ refreshToken: 'old', tenant })).user.role).toBe('aluno');
    await expect(f.service.refreshInstitution({ refreshToken: 'old', tenant, administrative: true })).rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_ACCESS_REQUIRED' });
    expect(f.auth.signOut).not.toHaveBeenCalled();
  });
  it.each(['USER_INACTIVE', 'USER_NOT_LINKED_TO_TENANT', 'TENANT_SUSPENDED'])('denies %s discovered after rotation without returning tokens or globally revoking other contexts', async code => {
    const f = fixture();
    (code === 'TENANT_SUSPENDED' ? f.tenants.requireOperationalById : f.repository.findUserByAuthId).mockRejectedValue(new HttpError(403, code, 'Denied'));
    await expect(f.service.refreshInstitution({ refreshToken: 'old', tenant })).rejects.toMatchObject({ code });
    expect(f.auth.refreshSession).toHaveBeenCalled();
    expect(f.auth.signOut).not.toHaveBeenCalled();
  });
  it('rechecks platform allowlist after rotation without institutional lookups', async () => {
    const original = [...env.PLATFORM_ADMIN_AUTH_USER_IDS];
    const f = fixture();
    try {
      env.PLATFORM_ADMIN_AUTH_USER_IDS = [principal];
      const result = await f.service.refreshPlatform('old');
      expect(result.authorization.authUserId).toBe(principal);
      env.PLATFORM_ADMIN_AUTH_USER_IDS = [];
      await expect(f.service.refreshPlatform('old')).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      expect(f.repository.findUserByAuthId).not.toHaveBeenCalled();
      expect(f.tenants.requireOperationalById).not.toHaveBeenCalled();
    } finally { env.PLATFORM_ADMIN_AUTH_USER_IDS = original; }
  });
});
