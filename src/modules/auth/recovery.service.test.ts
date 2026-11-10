import { AuthApiError } from '@supabase/supabase-js';
import { RecoveryService } from './recovery.service';
import { AuthOperationClient } from './session.client';
import { isSafeAuthRedirectUrl } from '../../config/env';

const identity = { id: 'synthetic-auth-id' };
const session = { access_token: 'verified-recovery-jwt', refresh_token: 'synthetic-refresh', user: identity };
function fixture(redirect: string | undefined = 'https://frontend.example.invalid/password') {
  const auth = { resetPasswordForEmail: jest.fn().mockResolvedValue({ data: {}, error: null }),
    verifyOtp: jest.fn().mockResolvedValue({ data: { session, user: identity }, error: null }),
    getUser: jest.fn().mockResolvedValue({ data: { user: identity }, error: null }),
    updateUser: jest.fn().mockResolvedValue({ data: { user: identity }, error: null }),
    signOut: jest.fn().mockResolvedValue({ error: null }) };
  const factory = jest.fn(() => ({ auth }) as unknown as AuthOperationClient);
  return { auth, factory, service: new RecoveryService(factory, () => redirect) };
}
describe('provider-only password proof and ephemeral sessions', () => {
  it.each([undefined, 'user_not_found', 'email_not_confirmed', 'over_email_send_rate_limit'])('keeps recovery account existence and per-address provider limits indistinguishable (%s)', async code => {
    const f = fixture();
    if (code) f.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: new AuthApiError('private email detail', code.includes('rate_limit') ? 429 : 400, code) });
    await expect(f.service.requestRecovery('synthetic@example.invalid')).resolves.toBeUndefined();
    expect(f.auth.resetPasswordForEmail).toHaveBeenCalledWith('synthetic@example.invalid', { redirectTo: 'https://frontend.example.invalid/password' });
  });
  it('requires configured server redirect before requesting provider email', async () => {
    const f = fixture();
    const service = new RecoveryService(f.factory, () => undefined);
    await expect(service.requestRecovery('synthetic@example.invalid')).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_RECOVERY_NOT_CONFIGURED' });
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('does not convert transport failures into false successful recovery', async () => {
    const f = fixture();
    f.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: new AuthApiError('private SMTP information', 503, 'unexpected_failure') });
    await expect(f.service.requestRecovery('synthetic@example.invalid')).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    f.auth.resetPasswordForEmail.mockRejectedValue(new Error('private transport'));
    await expect(f.service.requestRecovery('synthetic@example.invalid')).rejects.toMatchObject({ statusCode: 503 });
  });
  it('does not hide disabled email provider configuration as a successfully requested recovery', async () => {
    const f = fixture();
    f.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: new AuthApiError('private provider configuration', 400, 'email_provider_disabled') });
    await expect(f.service.requestRecovery('synthetic@example.invalid')).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_RECOVERY_UNAVAILABLE' });
  });
  it.each(['recovery', 'invite'] as const)('verifies fixed %s proof, validates JWT identity, changes only the verified account password and globally signs out', async type => {
    const f = fixture();
    await expect(f.service.changePassword({ tokenHash: 'synthetic-token-hash', newPassword: 'Synthetic123!' }, type)).resolves.toBeUndefined();
    expect(f.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'synthetic-token-hash', type });
    expect(f.auth.getUser).toHaveBeenCalledWith(session.access_token);
    expect(f.auth.updateUser).toHaveBeenCalledWith({ password: 'Synthetic123!' });
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(f.auth.updateUser.mock.invocationCallOrder[0]).toBeLessThan(f.auth.signOut.mock.invocationCallOrder[0]);
  });
  it.each(['otp_expired', 'otp_disabled', 'invalid_credentials', 'bad_jwt'])('rejects invalid/expired/wrong proof (%s) before changing a password', async code => {
    const f = fixture();
    f.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: new AuthApiError('private proof detail', 403, code) });
    await expect(f.service.changePassword({ tokenHash: 'synthetic', newPassword: 'Synthetic123!' }, 'recovery')).rejects.toMatchObject({ statusCode: 401, code: 'RECOVERY_INVALID_OR_EXPIRED' });
    expect(f.auth.updateUser).not.toHaveBeenCalled();
  });
  it('rejects missing session and different verified identity before update', async () => {
    const f = fixture();
    f.auth.getUser.mockResolvedValue({ data: { user: { id: 'other-account' } }, error: null });
    await expect(f.service.changePassword({ tokenHash: 'synthetic', newPassword: 'Synthetic123!' }, 'invite')).rejects.toMatchObject({ statusCode: 502 });
    expect(f.auth.updateUser).not.toHaveBeenCalled();
    f.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: null });
    await expect(f.service.changePassword({ tokenHash: 'synthetic', newPassword: 'Synthetic123!' }, 'recovery')).rejects.toMatchObject({ statusCode: 502 });
  });
  it('reports password changed with failed revocation explicitly and never retries password update', async () => {
    const f = fixture();
    f.auth.signOut.mockResolvedValue({ error: new AuthApiError('private signout', 503, 'unexpected_failure') });
    await expect(f.service.changePassword({ tokenHash: 'synthetic', newPassword: 'Synthetic123!' }, 'recovery')).rejects.toMatchObject({ statusCode: 503, code: 'PASSWORD_CHANGED_REVOCATION_FAILED' });
    expect(f.auth.updateUser).toHaveBeenCalledTimes(1);
  });
  it('creates an operation client for each request instead of retaining another user session', async () => {
    const f = fixture();
    await f.service.changePassword({ tokenHash: 'first-account-proof', newPassword: 'Synthetic123!' }, 'recovery');
    await f.service.changePassword({ tokenHash: 'second-account-proof', newPassword: 'Synthetic456!' }, 'invite');
    expect(f.factory).toHaveBeenCalledTimes(2);
  });
});
describe('server auth redirect validation', () => {
  it.each(['https://front.example.invalid/reset', 'http://localhost:3000/reset', 'http://127.0.0.1/reset', 'http://[::1]/reset'])('accepts safe nonproduction URL %s', url => expect(isSafeAuthRedirectUrl(url, 'test')).toBe(true));
  it.each(['https://user:secret@front.invalid/reset', 'https://@front.invalid/reset', 'https://front.invalid/reset?token=secret', 'https://front.invalid/reset#secret', 'http://front.invalid', 'javascript:alert(1)', 'https://front.invalid/reset?', 'https://front.invalid/reset#'])('rejects unsafe URL %s', url => expect(isSafeAuthRedirectUrl(url, 'test')).toBe(false));
  it('requires HTTPS in production', () => expect(isSafeAuthRedirectUrl('http://localhost/reset', 'production')).toBe(false));
});
