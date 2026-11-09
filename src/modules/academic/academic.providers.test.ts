import { AcademicOverviewSchema, AcademicPeriodsSchema } from './academic.contracts';
import { DemoAcademicProvider } from './providers/demo-academic.provider';
import { AcademicService } from './academic.service';
import { createConfiguredAcademicProvider } from './academic.providers';
import { AppUser, Tenant } from '../../shared/types';

const tenant: Tenant = { id: 'tenant-demo', slug: 'edukmais', name: 'EduKMais', plan: 'starter', status: 'active', activeUsers: 2 };
const user: AppUser = { id: 'synthetic-user-a', authUserId: 'synthetic-auth-a', tenantId: tenant.id, name: 'Pessoa fictícia', email: 'teste@example.test', role: 'student' };
const context = { userId: user.id, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name } };

describe('contratos e provedor acadêmico de demonstração', () => {
  afterEach(() => jest.restoreAllMocks());

  it('serve cinco disciplinas em dois períodos sem fetch e identifica dados fictícios', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Nenhuma rede permitida'));
    const provider = new DemoAcademicProvider(context);
    const periods = AcademicPeriodsSchema.parse(await provider.getPeriods());
    expect(periods.periods).toHaveLength(2);
    const overview = AcademicOverviewSchema.parse(await provider.getOverview());
    expect(overview.source).toMatchObject({ providerId: 'demo', demonstration: true });
    expect(overview.source.label).toMatch(/fictícios/);
    expect(overview.scope).toEqual({ userId: user.id, tenantId: tenant.id });
    expect(overview.subjects).toHaveLength(5);
    expect((await provider.getHistory()).periods.every(p => p.subjects.length === 5)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  it('mantém zero, null, ausência, faltas decimais e situações distintas sem calcular notas', async () => {
    const result = await new DemoAcademicProvider(context).getOverview();
    expect(result.subjects[0].grades?.finalAverage).toBe(0);
    expect(result.subjects[0].grades?.assessment2).toBeNull();
    expect(result.subjects[1].attendance.absences).toBe(7.5);
    expect(result.subjects[2].grades).not.toHaveProperty('exam');
    expect(result.subjects.flatMap(s => s.activities ?? [])).toHaveLength(4);
    expect(() => AcademicOverviewSchema.parse({ ...result, password: 'privado' })).toThrow();
    expect(() => AcademicOverviewSchema.parse({ ...result, subjects: [{ ...result.subjects[0], grades: { assessment1: NaN } }] })).toThrow();
  });

  it('não compartilha objetos, escopo ou dados mutáveis entre usuários', async () => {
    const provider = new DemoAcademicProvider(context);
    const a = await provider.getOverview();
    a.subjects[0].name = 'MODIFICADO';
    expect((await provider.getOverview()).subjects[0].name).not.toBe('MODIFICADO');
    const b = await new DemoAcademicProvider({ ...context, userId: 'synthetic-user-b' }).getOverview();
    expect(b.scope.userId).toBe('synthetic-user-b');
    expect(JSON.stringify(b)).not.toContain(user.id);
    await expect(provider.getOverview({ periodId: 'outro-periodo' })).rejects.toMatchObject({ code: 'ACADEMIC_PERIOD_NOT_FOUND' });
  });

  it('configuração do servidor desativa integração e limita demonstração ao tenant autorizado', async () => {
    await expect(createConfiguredAcademicProvider(context, { provider: 'disabled', demoTenantSlug: 'edukmais' })).rejects.toMatchObject({ statusCode: 503 });
    await expect(createConfiguredAcademicProvider(context, { provider: 'demo', demoTenantSlug: 'outra' })).rejects.toMatchObject({ statusCode: 403 });
    const provider = await createConfiguredAcademicProvider(context, { provider: 'demo', demoTenantSlug: 'edukmais' });
    expect(provider.source.demonstration).toBe(true);
  });

  it('serviço funciona com outra factory sem portal externo e sempre fecha provider', async () => {
    const provider = new DemoAcademicProvider(context);
    const close = jest.spyOn(provider, 'close');
    const service = new AcademicService(async () => provider);
    const result = await service.getOverview({ currentUser: user, tenant });
    expect(result.complete).toBe(true); expect(close).toHaveBeenCalledTimes(1);
    jest.spyOn(provider, 'getOverview').mockRejectedValue(new Error('password=PRIVADO cookie=PRIVADO'));
    await expect(service.getOverview({ currentUser: user, tenant })).rejects.toMatchObject({ code: 'ACADEMIC_PROVIDER_ERROR', message: 'Não foi possível consultar os dados acadêmicos.' });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('serviço rejeita usuários/retornos de outro tenant ou usuário antes de entregar dados', async () => {
    const provider = new DemoAcademicProvider(context);
    const factory = jest.fn(async () => provider);
    const service = new AcademicService(factory);
    await expect(service.getOverview({ currentUser: { ...user, tenantId: 'outro' }, tenant })).rejects.toMatchObject({ statusCode: 403 });
    expect(factory).not.toHaveBeenCalled();
    const wrong = await new DemoAcademicProvider({ ...context, userId: 'outra-pessoa' }).getOverview();
    jest.spyOn(provider, 'getOverview').mockResolvedValue(wrong);
    const close = jest.spyOn(provider, 'close');
    await expect(service.getOverview({ currentUser: user, tenant })).rejects.toMatchObject({ code: 'ACADEMIC_SCOPE_MISMATCH' });
    expect(close).toHaveBeenCalled();
  });
  it('valida também o escopo dos períodos aninhados e fecha em falha de contrato', async () => {
    const provider = new DemoAcademicProvider(context);
    const close = jest.spyOn(provider, 'close');
    const history = await provider.getHistory();
    history.periods[0].scope.userId = 'outro-usuario';
    jest.spyOn(provider, 'getHistory').mockResolvedValue(history);
    const service = new AcademicService(async () => provider);
    await expect(service.getHistory({ currentUser: user, tenant })).rejects.toMatchObject({ code: 'ACADEMIC_SCOPE_MISMATCH' });
    jest.spyOn(provider, 'getOverview').mockResolvedValue({ password: 'PRIVADO' } as never);
    await expect(service.getOverview({ currentUser: user, tenant })).rejects.toMatchObject({ code: 'ACADEMIC_INVALID_RESPONSE' });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
