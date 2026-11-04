import { RequestHandler } from 'express';

export const sensitiveResponse: RequestHandler = (request, response, next) => {
  response.set('Cache-Control', 'no-store, private');
  response.set('Pragma', 'no-cache');
  response.set('Surrogate-Control', 'no-store');
  response.vary('Authorization');
  response.vary('x-tenant-slug');
  delete request.headers['if-none-match'];
  delete request.headers['if-modified-since'];
  next();
};
