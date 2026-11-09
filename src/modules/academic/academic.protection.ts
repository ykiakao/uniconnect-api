import { RequestHandler } from 'express';
import { HttpError } from '../../shared/http-error';

export const academicHttpBoundary: RequestHandler = (request, response, next) => {
  const setHeader = response.setHeader.bind(response);
  response.setHeader = (name, value) => name.toLowerCase() === 'etag' ? response : setHeader(name, value);
  response.set('Cache-Control', 'no-store, private');
  response.set('Pragma', 'no-cache');
  response.set('Surrogate-Control', 'no-store');
  response.vary('Authorization'); response.vary('x-tenant-slug');
  delete request.headers['if-none-match']; delete request.headers['if-modified-since'];
  if (Number(request.header('content-length') ?? '0') > 0 || request.header('transfer-encoding')) {
    next(new HttpError(400, 'VALIDATION_ERROR', 'Estas consultas não aceitam corpo ou credenciais.'));
    return;
  }
  next();
};

export function createAcademicProtection({ maxPerMinute = 30, maxConcurrent = 4, now = Date.now } = {}): RequestHandler {
  const windows = new Map<string, { expires: number; count: number }>();
  let active = 0;
  return (request, response, next) => {
    if (!request.currentUser || !request.tenant) { next(new HttpError(401, 'AUTH_TOKEN_REQUIRED', 'Token de autenticação ausente.')); return; }
    const time = now();
    for (const [key, window] of windows) if (window.expires <= time) windows.delete(key);
    const key = `${request.tenant.id}:${request.currentUser.id}`;
    const window = windows.get(key) ?? { expires: time + 60000, count: 0 };
    if (active >= maxConcurrent || window.count >= maxPerMinute || (!windows.has(key) && windows.size >= 10000)) {
      response.set('Retry-After', String(Math.max(1, Math.ceil((window.expires - time) / 1000))));
      next(new HttpError(429, 'ACADEMIC_RATE_LIMIT', 'Limite de consultas acadêmicas atingido. Tente novamente em instantes.'));
      return;
    }
    window.count++; windows.set(key, window); active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once('finish', release); response.once('close', release);
    next();
  };
}
