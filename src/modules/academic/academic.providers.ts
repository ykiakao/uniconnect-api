import { env } from '../../config/env';
import { AcademicContext, AcademicProvider } from './academic.contracts';
import { AcademicError } from './academic.errors';
import { DemoAcademicProvider } from './providers/demo-academic.provider';
import { NativeAcademicProvider } from './providers/native-academic.provider';

type Selection = { provider: 'disabled' | 'demo' | 'native'; demoTenantSlug: string };
const registry = {
  demo: async (context: AcademicContext) => new DemoAcademicProvider(context),
  native: async (context: AcademicContext) => new NativeAcademicProvider(context),
};
export async function createConfiguredAcademicProvider(context: AcademicContext, selection: Selection = {
  provider: env.ACADEMIC_PROVIDER, demoTenantSlug: env.ACADEMIC_DEMO_TENANT_SLUG,
}): Promise<AcademicProvider> {
  if (selection.provider === 'disabled') throw new AcademicError('ACADEMIC_DISABLED');
  if (selection.provider === 'demo' && context.tenant.slug !== selection.demoTenantSlug) throw new AcademicError('ACADEMIC_FORBIDDEN');
  return registry[selection.provider](context);
}
