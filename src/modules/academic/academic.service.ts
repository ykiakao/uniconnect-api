import { ZodType } from 'zod';
import { AppUser, Tenant } from '../../shared/types';
import { AcademicContext, AcademicProvider, AcademicProviderFactory, AcademicPeriodsSchema, AcademicOverviewSchema, AcademicHistorySchema } from './academic.contracts';
import { AcademicError } from './academic.errors';
import { createConfiguredAcademicProvider } from './academic.providers';
import { NativeAcademicProvider } from './providers/native-academic.provider';
import { HttpError } from '../../shared/http-error';

type ContextParams = { currentUser: AppUser; tenant: Tenant };
export class AcademicService {
  constructor(private readonly factory: AcademicProviderFactory = createConfiguredAcademicProvider) {}
  private async run<T extends { scope: { userId: string; tenantId: string }; institution: { id: string }; source: { providerId: string; demonstration: boolean } }>(
    params: ContextParams, schema: ZodType<T>, operation: (provider: AcademicProvider) => Promise<unknown>,
  ): Promise<T> {
    if (params.currentUser.tenantId !== params.tenant.id) throw new AcademicError('ACADEMIC_FORBIDDEN');
    const context: AcademicContext = { userId: params.currentUser.id, tenant: { id: params.tenant.id, name: params.tenant.name, slug: params.tenant.slug } };
    let provider: AcademicProvider | undefined;
    try {
      provider = await this.factory(context);
      const parsed = schema.safeParse(await operation(provider));
      if (!parsed.success) throw new AcademicError('ACADEMIC_INVALID_RESPONSE');
      const result = parsed.data;
      const envelopes = 'periods' in result && Array.isArray(result.periods) ? [result, ...result.periods.filter(p => p && typeof p === 'object' && 'scope' in p)] : [result];
      for (const envelope of envelopes) {
        if (envelope.scope.userId !== context.userId || envelope.scope.tenantId !== context.tenant.id || envelope.institution.id !== context.tenant.id ||
          envelope.source.providerId !== provider.source.providerId || envelope.source.demonstration !== provider.source.demonstration) throw new AcademicError('ACADEMIC_SCOPE_MISMATCH');
      }
      return result;
    } catch (error) {
      if (error instanceof AcademicError) throw error;
      if (provider instanceof NativeAcademicProvider && error instanceof HttpError) throw error;
      throw new AcademicError('ACADEMIC_PROVIDER_ERROR');
    } finally {
      if (provider) {
        try { await provider.close(); }
        catch { throw new AcademicError('ACADEMIC_PROVIDER_ERROR'); }
      }
    }
  }
  getPeriods(params: ContextParams) { return this.run(params, AcademicPeriodsSchema, provider => provider.getPeriods()); }
  getOverview(params: ContextParams & { periodId?: string }) { return this.run(params, AcademicOverviewSchema, provider => provider.getOverview({ periodId: params.periodId })); }
  getHistory(params: ContextParams) { return this.run(params, AcademicHistorySchema, provider => provider.getHistory()); }
}
