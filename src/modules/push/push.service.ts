import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../../config/env';

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export async function sendPushNotification(
  token: string,
  payload: PushPayload,
): Promise<boolean> {
  if (env.FCM_ENABLED !== 'true') return false;

  try {
    if (!getApps().length) {
      initializeApp({
        credential: applicationDefault(),
        projectId: env.FIREBASE_PROJECT_ID,
      });
    }

    await getMessaging().send({
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'default',
        },
      },
    });

    return true;
  } catch {
    console.error('[FCM] Falha no envio da notificacao.');
    return false;
  }
}
