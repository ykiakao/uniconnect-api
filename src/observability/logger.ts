import { env } from '../config/env';

export type ErrorCategory = 'validation' | 'authentication' | 'authorization' | 'not_found' |
  'conflict' | 'rate_limit' | 'unavailable' | 'not_implemented' | 'internal' | 'request_aborted';

export function errorCategory(status: number): ErrorCategory {
  if ([400, 413, 415, 422].includes(status)) return 'validation';
  if (status === 401 || status === 424) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limit';
  if ([502, 503, 504].includes(status)) return 'unavailable';
  if (status === 501) return 'not_implemented';
  return 'internal';
}

type HttpLog = {
  requestId: string; method: string; route: string; status: number; durationMs: number;
  tenantId?: string; errorCategory?: ErrorCategory; errorCode?: string;
};

export function createLogger({ environment = env.NODE_ENV, write = (line: string) => { process.stdout.write(line); } }: {
  environment?: 'development' | 'production' | 'test'; write?: (line: string) => void;
} = {}) {
  function emit(level: string, event: string, fields: Record<string, unknown>) {
    if (environment === 'test') return;
    const record = { timestamp: new Date().toISOString(), level, service: 'uniconnect-api', environment, event, ...fields };
    try { write(`${JSON.stringify(record, null, environment === 'development' ? 2 : undefined)}\n`); } catch { /* A failed sink cannot change an HTTP response. */ }
  }
  return {
    request(fields: HttpLog) {
      emit(fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info', 'http_request', {
        requestId: fields.requestId, method: fields.method, route: fields.route, status: fields.status,
        durationMs: fields.durationMs, tenantId: fields.tenantId, errorCategory: fields.errorCategory,
        errorCode: fields.errorCode,
      });
    },
    startup() { emit('info', 'server_started', {}); },
  };
}

export const logger = createLogger();
