import { createClient } from '@supabase/supabase-js';
import * as supabase from '../../config/supabase';
import { CommunicationRepository } from './communication.repository';
import { CommunicationService } from './communication.service';
import { AppUser } from '../../shared/types';

const tenantId = '11111111-1111-1111-1111-111111111111';
const user: AppUser = { id: 'synthetic-user', tenantId, authUserId: 'synthetic-auth', name: 'Synthetic', email: 'synthetic@example.invalid', role: 'student', active: true };
const date = '2026-10-26T15:00:00+00:00';
const notice = { id: 'synthetic-notice', tenant_id: tenantId, author_id: 'synthetic-teacher', title: 'Synthetic', content: 'Synthetic notice', audience_type: 'institution', course_id: null, class_id: null, state: 'published', priority: 'medium', revision: 2, expires_at: null, published_at: date, created_at: date, updated_at: date, read_at: null, read_revision: null };
const notification = { id: 'synthetic-notification', tenant_id: tenantId, recipient_id: user.id, event_type: 'notice_published', resource_type: 'notice', resource_id: notice.id, created_at: date, read_at: null };

function response(body: unknown, status = 200, json = true) {
  const fetch = jest.fn(async () => new Response(json ? JSON.stringify(body) : String(body), { status, headers: json ? { 'content-type': 'application/json' } : {} }));
  const client = createClient('https://synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch } });
  jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client);
  return fetch;
}
afterEach(() => jest.restoreAllMocks());

describe('communication SDK boundary and sanitized errors', () => {
  it.each([
    ['P0002', 400, 404, 'COMMUNICATION_NOT_FOUND'], ['42501', 403, 403, 'FORBIDDEN'],
    ['P0002', 500, 404, 'COMMUNICATION_NOT_FOUND'], ['54000', 500, 409, 'COMMUNICATION_LIMIT_EXCEEDED'],
    ['40P01', 500, 409, 'DATA_CONFLICT'],
    ['22023', 400, 400, 'VALIDATION_ERROR'], ['22P02', 400, 400, 'VALIDATION_ERROR'],
    ['23505', 409, 409, 'DATA_CONFLICT'], ['23503', 409, 409, 'DATA_CONFLICT'],
    ['23514', 400, 409, 'DATA_CONFLICT'], ['40P01', 409, 409, 'DATA_CONFLICT'],
    ['54000', 413, 409, 'COMMUNICATION_LIMIT_EXCEEDED'], ['PGRST202', 404, 503, 'DATABASE_MIGRATION_REQUIRED'],
    ['42P01', 400, 503, 'DATABASE_MIGRATION_REQUIRED'], ['XX000', 400, 500, 'DATABASE_QUERY_FAILED'],
  ] as const)('maps %s without exposing SQL, tokens or message content', async (code, status, expectedStatus, expectedCode) => {
    const fetch = response({ code, message: 'PRIVATE SQL message token', details: 'PRIVATE content', hint: 'PRIVATE table' }, status);
    await expect(new CommunicationRepository().execute(tenantId, user.id, 'notification_count', {})).rejects.toMatchObject({ statusCode: expectedStatus, code: expectedCode, details: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats a non-JSON failed RPC as unavailable', async () => {
    response('PRIVATE proxy diagnostic', 503, false);
    await expect(new CommunicationService().execute(user, tenantId, 'notification_count', {})).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' });
  });
  it('accepts real PostgreSQL nullable unread metadata without fabricating a read', async () => {
    response(notice);
    await expect(new CommunicationService().execute(user, tenantId, 'notice_get', { id: notice.id })).resolves.toMatchObject({ id: notice.id, readAt: null, readRevision: 0 });
  });
  it('accepts a real PostgreSQL result page and maps only public DTO fields', async () => {
    response({ data: [{ ...notification, event_key: 'internal-key', user_id: user.id }], total: 1 });
    const result = await new CommunicationService().execute(user, tenantId, 'notification_list', { offset: 0, limit: 20 });
    expect(result).toEqual({ data: [{ id: notification.id, type: 'notice_published', resourceType: 'notice', resourceId: notice.id, createdAt: date, readAt: null }], meta: { page: 1, limit: 20, total: 1 } });
  });
  it.each([null, { data: null, total: 0 }, { data: [], total: -1 }])('rejects malformed success payload %#', async value => {
    response(value);
    await expect(new CommunicationService().execute(user, tenantId, 'notification_list', { offset: 0, limit: 20 })).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    { ...notification, tenant_id: 'other-tenant' }, { ...notification, recipient_id: 'other-user' },
  ])('rejects a valid notification outside the current scope %#', async value => {
    response(value);
    await expect(new CommunicationService().execute(user, tenantId, 'notification_read', { id: notification.id })).rejects.toMatchObject({ statusCode: 502 });
  });
  it('rejects an unexpectedly unordered message page', async () => {
    const message = { id: 'synthetic-message', tenant_id: tenantId, conversation_id: 'synthetic-conversation', sender_id: 'synthetic-teacher', content: 'Synthetic', sequence: 2, created_at: date, client_message_id: 'synthetic-client-id' };
    response({ data: [message, { ...message, id: 'second', sequence: 1 }], has_more: false, next_after_sequence: 1 });
    await expect(new CommunicationService().execute(user, tenantId, 'message_list', { id: message.conversation_id, afterSequence: 0, limit: 20 })).rejects.toMatchObject({ statusCode: 502 });
  });
  it('rejects mismatched identity before contacting the database', async () => {
    const fetch = response({ unread_count: 0 });
    await expect(new CommunicationService().execute(user, 'other-tenant', 'notification_count', {})).rejects.toMatchObject({ statusCode: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
