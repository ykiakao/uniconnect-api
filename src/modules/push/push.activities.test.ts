import { createSupabaseAdminClient } from '../../config/supabase';
import { env } from '../../config/env';
import { notifyActivityPublished } from './push.activities';
import { registerPushDevice, unregisterPushDevice } from './push.devices';
import { sendPushNotification } from './push.service';

jest.mock('./push.service', () => ({ sendPushNotification: jest.fn().mockResolvedValue(true) }));

const tokens = ['synthetic-active-device', 'synthetic-other-tenant', 'synthetic-other-student'];
function enrollmentQuery(data: unknown[], error: unknown = null) {
  const result = Promise.resolve({ data, error });
  const query = { select: jest.fn(), eq: jest.fn(), then: result.then.bind(result) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const from = jest.fn().mockReturnValue(query);
  jest.spyOn(require('../../config/supabase'), 'createSupabaseAdminClient').mockReturnValue({ from } as unknown as ReturnType<typeof createSupabaseAdminClient>);
  return { from, query };
}

beforeEach(() => {
  env.FCM_ENABLED = 'true';
  jest.mocked(sendPushNotification).mockClear();
  registerPushDevice('tenant', 'student', tokens[0]);
  registerPushDevice('other-tenant', 'student', tokens[1]);
  registerPushDevice('tenant', 'other-student', tokens[2]);
});
afterEach(() => {
  env.FCM_ENABLED = 'false';
  jest.restoreAllMocks();
  unregisterPushDevice('tenant', 'student', tokens[0]);
  unregisterPushDevice('other-tenant', 'student', tokens[1]);
  unregisterPushDevice('tenant', 'other-student', tokens[2]);
});

it('queries active enrollments in the correct tenant and class, and deduplicates recipients', async () => {
  const { from, query } = enrollmentQuery([{ student_id: 'student' }, { student_id: 'student' }]);
  await notifyActivityPublished('tenant', 'class', 'activity');
  expect(from).toHaveBeenCalledWith('enrollments');
  expect(query.select).toHaveBeenCalledWith('student_id');
  expect(query.eq.mock.calls).toEqual([['tenant_id', 'tenant'], ['class_id', 'class'], ['status', 'active']]);
  expect(sendPushNotification).toHaveBeenCalledTimes(1);
  expect(sendPushNotification).toHaveBeenCalledWith(tokens[0], expect.objectContaining({ data: { type: 'activity_published', activityId: 'activity', classId: 'class', tenantId: 'tenant' } }));
});

it('does not query enrollments or send when FCM is disabled', async () => {
  const { from } = enrollmentQuery([]);
  env.FCM_ENABLED = 'false';
  await notifyActivityPublished('tenant', 'class', 'activity');
  expect(from).not.toHaveBeenCalled();
  expect(sendPushNotification).not.toHaveBeenCalled();
});

it('does not send to devices without an eligible enrollment', async () => {
  enrollmentQuery([]);
  await notifyActivityPublished('tenant', 'class', 'activity');
  expect(sendPushNotification).not.toHaveBeenCalled();
});

it('sanitizes enrollment-query failures and does not notify', async () => {
  enrollmentQuery([], { message: 'synthetic-private-db-detail' });
  await expect(notifyActivityPublished('tenant', 'class', 'activity')).rejects.toThrow('Falha ao consultar alunos da turma.');
  expect(sendPushNotification).not.toHaveBeenCalled();
});
