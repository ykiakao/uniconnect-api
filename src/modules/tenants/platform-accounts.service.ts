import { randomUUID } from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { createSupabaseAdminClient } from '../../config/supabase';
import { PlatformPrincipal, requirePlatformCapability } from '../../shared/authorization';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';
import { parseAccountResult, PlatformAccountsRepository } from './platform-accounts.repository';
import { preparedDto, provisionDto, responsibleDto } from './platform-accounts.schemas';

type InviteClient = { auth: { admin: Pick<SupabaseClient['auth']['admin'], 'inviteUserByEmail'> } };
export class PlatformAccountsService {
  constructor(private readonly repository = new PlatformAccountsRepository(), private readonly createClient: () => InviteClient = createSupabaseAdminClient) {}
  list(principal: PlatformPrincipal, institutionId: string, pagination: Pagination) {
    requirePlatformCapability(principal, 'platform.accounts.provision');
    return this.repository.list(institutionId, pagination);
  }
  find(principal: PlatformPrincipal, institutionId: string, id: string) {
    requirePlatformCapability(principal, 'platform.accounts.provision');
    return this.repository.find(institutionId, id);
  }
  async provision(principal: PlatformPrincipal, institutionId: string, input: { name: string; email: string }, key: string, requestId: string) {
    requirePlatformCapability(principal, 'platform.accounts.provision');
    this.redirect();
    const provision = parseAccountResult(provisionDto, await this.repository.call(principal.authUserId, 'reserve_provision', key, requestId, { ...input, institutionId }));
    this.assertInstitution(institutionId, provision.institutionId);
    return this.resume(principal, institutionId, provision.id, requestId);
  }
  async resume(principal: PlatformPrincipal, institutionId: string, provisionId: string, requestId: string) {
    requirePlatformCapability(principal, 'platform.accounts.provision');
    const redirectTo = this.redirect();
    const payload = { institutionId, provisionId };
    const prepared = parseAccountResult(preparedDto, await this.repository.call(principal.authUserId, 'prepare_provision', randomUUID(), requestId, payload));
    this.assertProvision(institutionId, provisionId, prepared.provision);
    if (!prepared.inviteRequired) return prepared.provision;
    let failed = false;
    try {
      const result = await this.createClient().auth.admin.inviteUserByEmail(prepared.email, { redirectTo });
      failed = Boolean(result.error) && !['email_exists', 'user_already_exists', 'email_already_registered'].includes(result.error?.code ?? '');
      if (!result.error && (!result.data.user?.id || result.data.user.email?.toLowerCase() !== prepared.email.toLowerCase())) failed = true;
    } catch { failed = true; }
    try {
      const reconciled = parseAccountResult(preparedDto, await this.repository.call(principal.authUserId, 'reconcile_provision', randomUUID(), requestId, payload));
      this.assertProvision(institutionId, provisionId, reconciled.provision);
      if (!failed && reconciled.provision.state !== 'needs_review') return reconciled.provision;
    } catch { /* The durable intent survives an uncertain provider or checkpoint outcome. */ }
    throw new HttpError(503, 'ACCOUNT_PROVISIONING_PENDING', 'Provisionamento registrado; o resultado deve ser reconciliado antes de nova tentativa de convite.');
  }
  async responsible(principal: PlatformPrincipal, institutionId: string, requestId: string) {
    requirePlatformCapability(principal, 'platform.institutions.responsible.manage');
    const result = await this.repository.call(principal.authUserId, 'get_responsible', randomUUID(), requestId, { institutionId });
    if (result === null) throw new HttpError(404, 'RESPONSIBLE_NOT_DESIGNATED', 'Responsavel institucional ainda nao designado.');
    const dto = parseAccountResult(responsibleDto, result);
    this.assertInstitution(institutionId, dto.institutionId);
    return dto;
  }
  async changeResponsible(principal: PlatformPrincipal, institutionId: string, operation: 'designate_responsible' | 'replace_responsible', input: Record<string, unknown>, key: string, requestId: string) {
    requirePlatformCapability(principal, 'platform.institutions.responsible.manage');
    const result = parseAccountResult(responsibleDto, await this.repository.call(principal.authUserId, operation, key, requestId, { ...input, institutionId }));
    this.assertInstitution(institutionId, result.institutionId);
    return result;
  }
  history(principal: PlatformPrincipal, institutionId: string, pagination: Pagination) {
    requirePlatformCapability(principal, 'platform.audit.read');
    return this.repository.history(institutionId, pagination);
  }
  private redirect() {
    if (!env.AUTH_INVITE_REDIRECT_URL) throw new HttpError(503, 'ACCOUNT_INVITE_NOT_CONFIGURED', 'Ativacao de contas ainda nao configurada.');
    return env.AUTH_INVITE_REDIRECT_URL;
  }
  private assertInstitution(expected: string, actual: string) {
    if (expected !== actual) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta administrativa invalida.');
  }
  private assertProvision(institutionId: string, provisionId: string, provision: { institutionId: string; id: string }) {
    this.assertInstitution(institutionId, provision.institutionId);
    if (provisionId !== provision.id) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta administrativa invalida.');
  }
}
