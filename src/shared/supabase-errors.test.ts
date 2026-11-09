import { AuthSessionMissingError } from '@supabase/supabase-js';
import { checkAuthError, checkSupabaseAvailability, isAlreadyInvalidSession, requireCount } from './supabase-errors';

describe('Supabase SDK error semantics', () => {
  it('recognizes the real SDK missing-session error as already revoked', () => {
    expect(isAlreadyInvalidSession(new AuthSessionMissingError())).toBe(true);
  });
  it('reports the real SDK missing-session error as an invalid session', () => {
    expect(() => checkAuthError(new AuthSessionMissingError(), 'session')).toThrow(expect.objectContaining({ statusCode: 401, code: 'INVALID_SESSION' }));
  });
  it.each(['invalid_credentials', 'email_not_confirmed', 'phone_not_confirmed', 'user_banned'])('does not disguise rejected login %s as an internal failure', (code) => {
    expect(() => checkAuthError({ code, status: 400 }, 'credentials')).toThrow(expect.objectContaining({ statusCode: 401, code: 'INVALID_CREDENTIALS' }));
  });
  it('preserves upstream authentication rate limits', () => {
    expect(() => checkAuthError({ status: 429 }, 'session')).toThrow(expect.objectContaining({ statusCode: 429, code: 'AUTH_RATE_LIMIT' }));
  });
  it('does not classify unknown Auth errors as invalid credentials', () => {
    expect(() => checkAuthError({ status: 400, code: 'unexpected' }, 'credentials')).toThrow(expect.objectContaining({ statusCode: 500, code: 'AUTH_SERVICE_ERROR' }));
  });
  it.each(['', '08006', 'PGRST003', '53300', '57P01'])('reports known database transport failure %s as unavailable', (code) => {
    expect(() => checkSupabaseAvailability({ code })).toThrow(expect.objectContaining({ statusCode: 503 }));
  });
  it.each([null, undefined, -1, 0.5])('rejects invalid count %s', (count) => {
    expect(() => requireCount(count as number | null)).toThrow(expect.objectContaining({ statusCode: 502 }));
  });
});
