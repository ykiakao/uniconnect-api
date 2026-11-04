import { randomUUID } from 'node:crypto';
import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../shared/http-error';

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Erro interno do servidor.';
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    status = 400; code = 'INVALID_JSON'; message = 'JSON invalido.';
  } else if (error && typeof error === 'object' && error.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'O corpo da requisicao excede o tamanho permitido.';
  } else if (error instanceof ZodError) {
    status = 400; code = 'VALIDATION_ERROR'; message = 'Dados inv\u00e1lidos.';
  } else if (error instanceof HttpError) {
    status = error.statusCode; code = error.code; message = error.message;
  }
  response.locals.errorCode = code;
  if (response.headersSent) { response.destroy(); return; }
  const requestId = request.requestId ?? randomUUID();
  response.set('X-Request-Id', requestId);
  response.status(status).json({ error: { code, message, requestId } });
};
