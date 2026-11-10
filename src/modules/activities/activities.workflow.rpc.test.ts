import { createClient } from '@supabase/supabase-js';
import * as supabase from '../../config/supabase';
import { activityRpc } from './activities.workflow.rpc';
import { ActivitiesRepository } from './activities.repository';

afterEach(() => jest.restoreAllMocks());

function dependency(body: unknown, status = 200, json = true) {
  const fetch = jest.fn(async () => new Response(json ? JSON.stringify(body) : String(body), {
    status, headers: json ? { 'content-type': 'application/json' } : {},
  }));
  const client = createClient('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
  });
  jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client);
  return fetch;
}

describe('activity workflow real SDK boundary, synthetic fetch only', () => {
  it.each([
    ['P0002', 400, 404, 'ACTIVITY_RECORD_NOT_FOUND'],
    ['P0002', 500, 404, 'ACTIVITY_RECORD_NOT_FOUND'],
    ['54000', 500, 409, 'COMMUNICATION_LIMIT_EXCEEDED'],
    ['40P01', 500, 409, 'DATA_CONFLICT'],
    ['42501', 403, 403, 'FORBIDDEN'],
    ['23514', 400, 409, 'DATA_CONFLICT'],
    ['23505', 409, 409, 'DATA_CONFLICT'],
    ['22023', 400, 400, 'VALIDATION_ERROR'],
    ['22P02', 400, 400, 'VALIDATION_ERROR'],
    ['PGRST202', 404, 503, 'DATABASE_MIGRATION_REQUIRED'],
    ['42P01', 400, 503, 'DATABASE_MIGRATION_REQUIRED'],
    ['XX000', 400, 500, 'DATABASE_QUERY_FAILED'],
  ] as const)('maps SQLSTATE %s without exposing SQL diagnostics', async (code, status, expectedStatus, expectedCode) => {
    const fetch = dependency({ code, message: 'PRIVATE SQL answer token', details: 'PRIVATE details', hint: 'PRIVATE hint' }, status);
    await expect(activityRpc('submit_activity_answer', { p_answer: 'Synthetic answer' })).rejects.toMatchObject({
      statusCode: expectedStatus, code: expectedCode, details: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a non-JSON failed RPC as unavailable', async () => {
    dependency('PRIVATE gateway details', 503, false);
    await expect(activityRpc('submit_activity_answer', {})).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('rejects a successful RPC with no record', async () => {
    dependency(null);
    await expect(activityRpc('submit_activity_answer', {})).rejects.toMatchObject({ statusCode: 502, code: 'DEPENDENCY_INVALID_RESPONSE' });
  });

  it('rejects malformed activity rows before mapping them', async () => {
    dependency({ activities: [null], total: 1 });
    await expect(new ActivitiesRepository().visibleToStudent('tenant', 'actor', 'class', { page: 1, limit: 20, offset: 0 }))
      .rejects.toMatchObject({ statusCode: 502, code: 'DEPENDENCY_INVALID_RESPONSE' });
  });

  it('rejects an activity response from a different tenant', async () => {
    dependency({ id: 'activity', tenant_id: 'other', class_id: 'class', title: 'Synthetic', type: 'assignment', state: 'draft' });
    await expect(new ActivitiesRepository().manage('tenant', 'actor', 'create', { classId: 'class' }))
      .rejects.toMatchObject({ statusCode: 502, code: 'DEPENDENCY_INVALID_RESPONSE' });
  });
});
