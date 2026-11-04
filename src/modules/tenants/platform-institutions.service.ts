import { PlatformPrincipal, requirePlatformCapability } from '../../shared/authorization';
import { Pagination } from '../../shared/pagination';
import { PlatformInstitutionsRepository } from './platform-institutions.repository';
import { PlatformOperation } from './platform-institutions.schemas';

export class PlatformInstitutionsService {
  private readonly repository = new PlatformInstitutionsRepository();
  list(principal: PlatformPrincipal, pagination: Pagination, search?: string, status?: string) {
    requirePlatformCapability(principal, 'platform.institutions.read');
    return this.repository.list(pagination, search, status);
  }
  find(principal: PlatformPrincipal, id: string) {
    requirePlatformCapability(principal, 'platform.institutions.read');
    return this.repository.find(id);
  }
  mutate(principal: PlatformPrincipal, operation: PlatformOperation, key: string, requestId: string, payload: Record<string, unknown>) {
    requirePlatformCapability(principal, operation === 'bootstrap' ? 'platform.institutions.bootstrap' : 'platform.institutions.manage');
    return this.repository.mutate(principal.authUserId, operation, key, requestId, payload);
  }
  audit(principal: PlatformPrincipal, id: string, pagination: Pagination) {
    requirePlatformCapability(principal, 'platform.audit.read');
    return this.repository.audit(id, pagination);
  }
}
