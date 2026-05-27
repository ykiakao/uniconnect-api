import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { env } from '../config/env';
import { HttpError } from '../shared/http-error';

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: 'validation_error',
      message: 'Dados inválidos.',
      details: error.flatten(),
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.statusCode).json({
      error: 'request_error',
      message: error.message,
      details: error.details,
    });
    return;
  }

  response.status(500).json({
    error: 'internal_error',
    message: 'Erro interno do servidor.',
    details: env.NODE_ENV === 'development' ? String(error) : undefined,
  });
};
