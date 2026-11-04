import { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { HttpError } from '../../shared/http-error';
import { invalidAuthResponse } from '../../shared/supabase-errors';

export type AuthOperationClient = { auth: Pick<SupabaseClient['auth'],
  'refreshSession' | 'getUser' | 'resetPasswordForEmail' | 'verifyOtp' | 'updateUser' | 'signOut'> };
export type AuthOperationClientFactory = () => AuthOperationClient;

export async function authOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'O servico de autenticacao esta temporariamente indisponivel.');
  }
}

export function requireCoherentSession(data: { session: Session | null; user: User | null }): Session {
  const { session, user } = data;
  if (!session?.access_token || !session.refresh_token || !session.user?.id || !user?.id || session.user.id !== user.id) invalidAuthResponse();
  return session;
}

export function requireVerifiedIdentity(user: User | null, expectedId: string): User {
  if (!user?.id || user.id !== expectedId) invalidAuthResponse();
  return user;
}

export function sessionTokens(session: Session) {
  const seconds = session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
  if (!Number.isFinite(seconds)) invalidAuthResponse();
  return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: new Date(seconds * 1000).toISOString() };
}
