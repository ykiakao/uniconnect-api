import { HttpError } from './http-error';

export type Pagination = {
  page: number;
  limit: number;
  offset: number;
};

export type Paginated<T> = {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
  };
};

export function parsePagination(query: {
  page?: unknown;
  limit?: unknown;
}): Pagination {
  function positiveInteger(value: unknown, fallback: number) {
    if (value === undefined) return fallback;
    if (!['string', 'number'].includes(typeof value) ||
        (typeof value === 'string' && !/^\d+$/.test(value))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Paginacao invalida.');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new HttpError(400, 'VALIDATION_ERROR', 'Paginacao invalida.');
    return parsed;
  }
  const page = positiveInteger(query.page, 1);
  const limit = Math.min(positiveInteger(query.limit, 20), 100);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + limit - 1)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Paginacao invalida.');
  }
  return { page, limit, offset };
}

export function toPaginated<T>(params: {
  data: T[];
  total: number | null;
  page: number;
  limit: number;
}): Paginated<T> {
  return {
    data: params.data,
    meta: {
      page: params.page,
      limit: params.limit,
      total: params.total ?? params.data.length,
    },
  };
}
