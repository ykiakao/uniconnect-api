import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RequestHandler } from 'express';
import { createLogger, errorCategory, logger as defaultLogger } from './logger';

declare global {
  namespace Express {
    interface Request { requestId?: string; }
  }
}

export function createHttpObservability({ logger = defaultLogger, resolveRoute, now = () => performance.now() }: {
  logger?: ReturnType<typeof createLogger>; resolveRoute: (method: string, path: string) => string; now?: () => number;
}): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    request.requestId = requestId;
    response.set('X-Request-Id', requestId);
    const start = now();
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method) ? request.method : 'OTHER';
    const route = resolveRoute(method, request.path);
    let logged = false;
    const complete = () => {
      if (logged) return;
      logged = true;
      const aborted = !response.writableFinished;
      const status = aborted ? 499 : response.statusCode;
      const tenantId = request.currentUser?.tenantId === request.tenant?.id &&
        /^[a-f0-9-]{36}$/i.test(request.tenant?.id ?? '') ? request.tenant?.id : undefined;
      logger.request({
        requestId, method, route, status, durationMs: Math.max(0, Math.round((now() - start) * 100) / 100), tenantId,
        errorCategory: aborted ? 'request_aborted' : status >= 400 ? errorCategory(status) : undefined,
        errorCode: typeof response.locals.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(response.locals.errorCode) ? response.locals.errorCode : undefined,
      });
    };
    response.once('finish', complete);
    response.once('close', complete);
    next();
  };
}
