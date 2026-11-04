import { HttpError } from './http-error';
import { isAuthSessionMissingError } from '@supabase/supabase-js';

function fields(error: unknown) {
  return error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; name?: unknown } : {};
}

export function checkSupabaseAvailability(error: unknown, responseStatus?: number) {
  const { code, status: errorStatus, name } = fields(error);
  const status = responseStatus ?? errorStatus;
  if (!error && status !== 0 && !(typeof status === 'number' && status >= 500)) return;
  if (status === 0 || (typeof status === 'number' && status >= 500) || name === 'AuthRetryableFetchError' ||
    code === '' || (typeof code === 'string' && (/^(08|53)/.test(code) || ['57P01', '57P02', '57P03', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)))) {
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'O servico de dados esta temporariamente indisponivel. Tente novamente mais tarde.');
  }
}

export function checkQueryError(error: unknown, responseStatus?: number) {
  if (fields(error).code === 'PT403') throw new HttpError(403, 'TENANT_SUSPENDED', 'A instituicao esta suspensa.');
  if (error) checkMutationConflict(error);
  checkSupabaseAvailability(error, responseStatus);
  if (!error) return;
  const { code } = fields(error);
  if (code === '22P02') throw new HttpError(400, 'VALIDATION_ERROR', 'Identificador invalido.');
  throw new HttpError(500, 'DATABASE_QUERY_FAILED', 'Nao foi possivel concluir a consulta de dados.');
}

export function checkMutationConflict(error: unknown) {
  if (['23505', '23503', '23514', '40P01'].includes(String(fields(error).code))) {
    throw new HttpError(409, 'DATA_CONFLICT', 'A operacao conflita com os registros existentes.');
  }
}

export function requireRows<T>(data: T[] | null): T[] {
  if (!Array.isArray(data)) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'O servico de dados retornou uma resposta invalida.');
  return data;
}

export function requireCount(count: number | null) {
  if (count === null || !Number.isSafeInteger(count) || count < 0) {
    throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'O servico de dados retornou uma resposta invalida.');
  }
  return count;
}

export function checkAuthError(error: unknown, kind: 'credentials' | 'session') {
  if (!error) return;
  checkSupabaseAvailability(error);
  const { code, status } = fields(error);
  if (status === 429) throw new HttpError(429, 'AUTH_RATE_LIMIT', 'Limite de autenticacao atingido. Tente novamente mais tarde.');
  const invalid = kind === 'credentials' ? ['invalid_credentials', 'email_not_confirmed', 'phone_not_confirmed', 'user_banned'] : ['bad_jwt', 'session_not_found', 'user_not_found', 'session_expired'];
  if (invalid.includes(String(code)) || status === 401 || status === 403 || isAuthSessionMissingError(error)) {
    throw new HttpError(401, kind === 'credentials' ? 'INVALID_CREDENTIALS' : 'INVALID_SESSION',
      kind === 'credentials' ? 'E-mail ou senha incorretos' : 'Sessao invalida ou expirada.');
  }
  throw new HttpError(500, 'AUTH_SERVICE_ERROR', 'Nao foi possivel concluir a autenticacao.');
}

export function invalidAuthResponse(): never {
  throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'O servico de autenticacao retornou uma resposta invalida.');
}

export function isAlreadyInvalidSession(error: unknown) {
  const { code, status } = fields(error);
  return isAuthSessionMissingError(error) || status === 401 || status === 404 || ['bad_jwt', 'session_not_found', 'user_not_found', 'session_expired'].includes(String(code));
}

export function isExistingAuthUser(error: unknown) {
  return ['user_already_exists', 'email_exists'].includes(String(fields(error).code));
}
