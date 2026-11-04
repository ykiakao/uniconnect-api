import { AcademicContext, AcademicProvider, AcademicSource, AcademicSubject } from '../academic.contracts';
import { AcademicError } from '../academic.errors';

const periods = [{ id: 'demo-2026-2', name: '2026.2 (demonstração)' }, { id: 'demo-2026-1', name: '2026.1 (demonstração)' }];
const names = ['Arquitetura de Software', 'Banco de Dados', 'Engenharia de Requisitos', 'Testes de Software', 'Projeto Integrador'];

export class DemoAcademicProvider implements AcademicProvider {
  readonly source: AcademicSource = { providerId: 'demo', demonstration: true, label: 'Dados fictícios para demonstração — sem consulta a portais' };
  private readonly context: AcademicContext;
  constructor(context: AcademicContext) { this.context = structuredClone(context); }
  private envelope() {
    return { source: { ...this.source }, scope: { userId: this.context.userId, tenantId: this.context.tenant.id },
      institution: { ...this.context.tenant }, complete: true, warnings: [] };
  }
  async getPeriods() { return { ...this.envelope(), periods: structuredClone(periods) }; }
  async getOverview({ periodId = periods[0].id }: { periodId?: string | number } = {}) {
    const period = periods.find(item => item.id === periodId);
    if (!period) throw new AcademicError('ACADEMIC_PERIOD_NOT_FOUND');
    const previous = period.id === 'demo-2026-1';
    const subjects: AcademicSubject[] = names.map((name, index) => {
      const offeringId = `${period.id}-offering-${index + 1}`;
      return { id: `demo-subject-${index + 1}`, offeringId, periodId: period.id, name,
        status: previous ? 'passed' : 'in_progress', statusLabel: previous ? 'Aprovado (fictício)' : 'Cursando (fictício)',
        attendance: { absences: index === 1 ? 7.5 : 0, absencePercentage: index === 1 ? 12.5 : 0 },
        grades: index === 2 ? { assessment1: null, assessment2: null, average: null } : {
          assessment1: [9, 7, 0, 8, 10][index], assessment2: previous ? 8 : null,
          average: previous ? 8 : null, exam: null, finalAverage: previous ? 8 : 0,
        },
        activities: index < 4 ? [{ id: `${offeringId}-activity-1`, activityId: `demo-task-${index + 1}`, offeringId, periodId: period.id,
          description: `Exercício fictício de ${name}`, type: 'assignment', status: 'pending', statusLabel: 'Pendente (fictício)',
          returnDeadline: previous ? '2026-06-15T23:59:00-05:00' : '2026-11-15T23:59:00-05:00', hasAttachment: false }] : [],
        activitiesComplete: true,
      };
    });
    return { ...this.envelope(), period: { ...period }, subjects };
  }
  async getHistory() {
    const results = [];
    for (const period of periods) results.push(await this.getOverview({ periodId: period.id }));
    return { ...this.envelope(), periods: results };
  }
  async close() { /* Dados sintéticos não possuem sessão externa. */ }
}
