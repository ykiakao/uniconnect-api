import { z } from 'zod';
import { HttpError } from '../../shared/http-error';

export const chatServiceWindow = Object.freeze({
  timeZone: 'America/Rio_Branco', weekdays: [1, 2, 3, 4, 5], opensAt: '13:00', closesAt: '18:00',
});
const localClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: chatServiceWindow.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function chatServiceOpen(now: Date): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  const parts = Object.fromEntries(localClock.formatToParts(now).map(part => [part.type, part.value]));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday) && Number(parts.hour) >= 13 && Number(parts.hour) < 18;
}

export function chatTopic(tenantId: string, conversationId: string, authUserId: string): string {
  const ids = [tenantId, conversationId, authUserId];
  if (!ids.every(id => z.guid().safeParse(id).success)) {
    throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Identidade de canal invalida.');
  }
  return 'uc:chat:' + ids.map(id => id.toLowerCase()).join(':');
}
