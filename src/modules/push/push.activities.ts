import { createSupabaseAdminClient } from '../../config/supabase';
import { getPushTokens } from './push.devices';
import { env } from '../../config/env';
import { sendPushNotification } from './push.service';

export async function notifyActivityPublished(
  tenantId: string,
  classId: string,
  activityId: string,
): Promise<void> {
  if (env.FCM_ENABLED !== 'true') return;
  const db = createSupabaseAdminClient();

  const { data, error } = await db
    .from('enrollments')
    .select('student_id')
    .eq('tenant_id', tenantId)
    .eq('class_id', classId)
    .eq('status', 'active');

  if (error) {
    throw new Error('Falha ao consultar alunos da turma.');
  }

  const studentIds = [...new Set(
    (data ?? []).map((row) => String(row.student_id)),
  )];

  const tokens = getPushTokens(tenantId, studentIds);

  await Promise.all(
    tokens.map((token) =>
      sendPushNotification(token, {
        title: 'Nova atividade publicada',
        body: 'Uma nova atividade esta disponivel no UniConnect.',
        data: {
          type: 'activity_published',
          activityId,
          classId,
          tenantId,
        },
      }),
    ),
  );
}
