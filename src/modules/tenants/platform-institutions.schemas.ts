import { z } from 'zod';

const name = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const institutionId = z.guid();
export const operationalStatus = z.enum(['active', 'suspended']);
export const institutionCreate = z.object({ name, slug: z.string().min(3).max(63).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/) }).strict();
export const institutionVersion = z.object({ expectedVersion: z.number().int().min(1).max(2147483646) }).strict();
export const institutionUpdate = institutionVersion.extend({ name }).strict();
export const institutionBootstrap = z.object({ name, email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).strict();
export const institutionDto = z.object({ id: institutionId, name: z.string(), slug: z.string(), operationalStatus, version: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string() }).strict();
export const bootstrapDto = z.object({ institutionId, administrator: z.object({ id: z.string().min(1), role: z.literal('admin'), active: z.literal(true) }).strict() }).strict();
export type InstitutionDto = z.infer<typeof institutionDto>;
export type PlatformOperation = 'create' | 'update' | 'suspend' | 'reactivate' | 'bootstrap';
