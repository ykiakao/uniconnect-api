import { randomBytes } from 'node:crypto';

import { HttpError } from '../../shared/http-error';
import { canManageTenant, ensureCanAssignRole, toUserRole } from '../../shared/roles';
import { ApiUserRole, AppUser } from '../../shared/types';
import { InvitesRepository } from './invites.repository';
import { AuthService } from '../auth/auth.service';
import { AuthRepository } from '../auth/auth.repository';

export class InvitesService {
  private readonly repository = new InvitesRepository();

  async create(params: {
    currentUser: AppUser;
    tenantSlug: string;
    tenantId: string;
    role: ApiUserRole;
    expiresIn?: number;
    recipientEmail: string;
  }) {
    if (!canManageTenant(params.currentUser.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso nao permitido');
    }

    const expiresInDays = params.expiresIn ?? 7;
    ensureCanAssignRole(params.currentUser.role, toUserRole(params.role));
    const expiresAt = new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return this.repository.create({
      tenantId: params.tenantId,
      code: this.generateCode(params.tenantSlug),
      role: toUserRole(params.role),
      expiresAt,
      createdBy: params.currentUser.authUserId,
      recipientEmail: params.recipientEmail.trim().toLowerCase(),
    });
  }

  async resolve(code: string) {
    return this.repository.findActiveByCode(code.trim().toUpperCase());
  }

  private async eligible(code: string, email: string, expectedTenantId?: string) {
    const invite = await this.repository.findConsumable(code);
    if (expectedTenantId && expectedTenantId !== invite.tenant_id) throw new HttpError(404, 'INVITE_NOT_FOUND', 'Convite nao encontrado.');
    if (!invite.recipient_email || invite.recipient_email.trim().toLowerCase() !== email) throw new HttpError(403, 'INVITE_FORBIDDEN', 'Destinatario do convite nao autorizado.');
    if (!invite.created_by) throw new HttpError(403, 'INVITE_FORBIDDEN', 'Emissor do convite nao autorizado.');
    const issuer = await new AuthRepository().findUserByAuthId({ authUserId: invite.created_by, tenantId: invite.tenant_id });
    ensureCanAssignRole(issuer.role, invite.role);
    return invite;
  }

  async accept(code: string, accessToken: string, name: string, expectedTenantId?: string, requestId?: string) {
    const identity = await new AuthService().confirmedIdentity(accessToken);
    const invite = await this.eligible(code, identity.email, expectedTenantId);
    return this.repository.accept(code, identity, name, invite.tenant_id, requestId);
  }

  async register(code: string, input: { name: string; email: string; password: string }, expectedTenantId?: string, requestId?: string) {
    const invite = await this.eligible(code, input.email, expectedTenantId);
    const identity = await new AuthService().createInvitedAccount(input.email, input.password);
    return this.repository.accept(code, identity, input.name, invite.tenant_id, requestId);
  }

  async loginAndAccept(code: string, input: { name: string; email: string; password: string }, expectedTenantId?: string, requestId?: string) {
    const invite = await this.eligible(code, input.email, expectedTenantId);
    const { identity, session } = await new AuthService().invitedSession(input.email, input.password);
    const user = await this.repository.accept(code, identity, input.name, invite.tenant_id, requestId);
    return { ...session, user };
  }

  private generateCode(tenantSlug: string) {
    const prefix = tenantSlug
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase()
      .padEnd(3, 'U');
    const token = randomBytes(24).toString('hex').toUpperCase();

    return `${prefix}-${token}`;
  }
}
