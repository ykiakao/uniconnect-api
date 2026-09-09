import { randomBytes } from 'node:crypto';

import { HttpError } from '../../shared/http-error';
import { canManageTenant, toUserRole } from '../../shared/roles';
import { ApiUserRole, AppUser } from '../../shared/types';
import { InvitesRepository } from './invites.repository';

export class InvitesService {
  private readonly repository = new InvitesRepository();

  async create(params: {
    currentUser: AppUser;
    tenantSlug: string;
    tenantId: string;
    role: ApiUserRole;
    expiresIn?: number;
  }) {
    if (!canManageTenant(params.currentUser.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso nao permitido');
    }

    const expiresInDays = params.expiresIn ?? 7;
    const expiresAt = new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return this.repository.create({
      tenantId: params.tenantId,
      code: this.generateCode(params.tenantSlug),
      role: toUserRole(params.role),
      expiresAt,
      createdBy: params.currentUser.authUserId,
    });
  }

  async resolve(code: string) {
    return this.repository.findActiveByCode(code.trim().toUpperCase());
  }

  private generateCode(tenantSlug: string) {
    const prefix = tenantSlug
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase()
      .padEnd(3, 'U');
    const token = randomBytes(4).toString('hex').toUpperCase();

    return `${prefix}-${token}`;
  }
}
