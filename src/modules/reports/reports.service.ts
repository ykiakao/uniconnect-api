import { HttpError } from '../../shared/http-error';
import { canManageTenant } from '../../shared/roles';
import { AppUser } from '../../shared/types';
import { ReportsRepository } from './reports.repository';

export class ReportsService {
  private readonly repository = new ReportsRepository();

  async summary(params: { currentUser: AppUser; tenantId: string }) {
    this.ensureCanAccessTenantReports(params.currentUser);
    return this.repository.summary(params.tenantId);
  }

  async engagement(params: {
    currentUser: AppUser;
    tenantId: string;
    from?: string;
    to?: string;
    courseId?: string;
  }) {
    this.ensureCanAccessTenantReports(params.currentUser);
    return this.repository.engagement(params);
  }

  async global(currentUser: AppUser) {
    if (currentUser.role !== 'admin' && currentUser.role !== 'owner') {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
    }

    return this.repository.global();
  }

  private ensureCanAccessTenantReports(user: AppUser) {
    if (!canManageTenant(user.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso nÃ£o permitido');
    }
  }
}
