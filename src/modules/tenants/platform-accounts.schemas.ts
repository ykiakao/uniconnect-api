import { z } from 'zod';
import { institutionBootstrap, institutionId } from './platform-institutions.schemas';

export const provisionInput = institutionBootstrap;
export const designateInput = z.object({ administratorId: institutionId, expectedVersion: z.literal(0) }).strict();
export const replaceInput = institutionBootstrap.extend({ expectedVersion: z.number().int().min(1).max(2147483646) }).strict();
export const provisionDto = z.object({
  id: institutionId, institutionId, state: z.enum(['pending', 'invite_requested', 'awaiting_confirmation', 'ready', 'needs_review']),
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const preparedDto = z.object({ provision: provisionDto, inviteRequired: z.boolean(), email: z.string().email() }).strict();
export const responsibleDto = z.object({ institutionId, responsibleUserId: institutionId, version: z.number().int().positive() }).strict();
export type Provision = z.infer<typeof provisionDto>;
export type AccountOperation = 'reserve_provision' | 'prepare_provision' | 'reconcile_provision' | 'get_responsible' | 'designate_responsible' | 'replace_responsible';
