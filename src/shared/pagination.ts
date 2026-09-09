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
  const page = Math.max(Number(query.page ?? 1), 1);
  const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);

  return {
    page: Number.isFinite(page) ? page : 1,
    limit: Number.isFinite(limit) ? limit : 20,
    offset: ((Number.isFinite(page) ? page : 1) - 1) *
      (Number.isFinite(limit) ? limit : 20),
  };
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
