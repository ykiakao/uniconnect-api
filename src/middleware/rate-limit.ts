import { RequestHandler } from 'express';
import { HttpError } from '../shared/http-error';

export function createRateLimit({ max, windowMs, maxKeys = 10000, now = Date.now }: {
  max: number; windowMs: number; maxKeys?: number; now?: () => number;
}): RequestHandler {
  const windows = new Map<string, { count: number; expires: number }>();
  return (request, response, next) => {
    const time = now();
    for (const [key, window] of windows) if (window.expires <= time) windows.delete(key);
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const window = windows.get(key) ?? { count: 0, expires: time + windowMs };
    if (window.count >= max || (!windows.has(key) && windows.size >= maxKeys)) {
      response.set('Retry-After', String(Math.max(1, Math.ceil((window.expires - time) / 1000))));
      next(new HttpError(429, 'RATE_LIMIT_EXCEEDED', 'Limite de requisicoes atingido. Tente novamente mais tarde.'));
      return;
    }
    window.count++;
    windows.set(key, window);
    next();
  };
}
