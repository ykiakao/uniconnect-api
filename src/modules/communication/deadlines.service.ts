import { z } from 'zod';
import { createSupabaseAdminClient } from '../../config/supabase';
import { checkCommunicationError } from './communication.repository';
import { parseCommunication } from './communication.dto';

const inputSchema = z.object({
  tenantId: z.guid(), windowMinutes: z.coerce.number().int().min(1).max(10080).default(1440),
  limit: z.coerce.number().int().min(1).max(100).default(100), afterId: z.guid().nullable().default(null),
}).strict();
type DeadlineInput = z.infer<typeof inputSchema>;
const resultSchema = z.object({
  processed_activities: z.number().int().min(0).max(100), created_notifications: z.number().int().nonnegative().safe(),
  has_more: z.boolean(), next_after_id: z.guid().nullable(),
}).refine(value => !value.has_more || value.next_after_id !== null);

export function parseDeadlineArguments(args: string[]): DeadlineInput {
  const names: Record<string, string> = { '--tenant-id': 'tenantId', '--window-minutes': 'windowMinutes', '--limit': 'limit', '--after-id': 'afterId' };
  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || value === undefined || key in input) throw new Error('Argumentos de manutencao invalidos.');
    input[key] = value;
  }
  return inputSchema.parse(input);
}

export class DeadlineNotificationService {
  async run(input: DeadlineInput) {
    const value = inputSchema.parse(input);
    const { data, error, status } = await createSupabaseAdminClient().rpc('generate_academic_deadline_notifications', {
      p_tenant_id: value.tenantId, p_window_minutes: value.windowMinutes, p_limit: value.limit, p_after_id: value.afterId,
    });
    checkCommunicationError(error, status);
    const result = parseCommunication(resultSchema, data);
    return { processedActivities: result.processed_activities, createdNotifications: result.created_notifications,
      hasMore: result.has_more, nextAfterId: result.next_after_id };
  }
}
