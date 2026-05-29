export type UserRole = 'student' | 'teacher' | 'admin' | 'coordinator' | 'owner';

export type ApiUserRole = 'aluno' | 'professor' | 'gestor' | 'admin';

export type SubscriptionPlan = 'starter' | 'growth' | 'enterprise';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due';

export type Tenant = {
  id: string;
  name: string;
  slug: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  activeUsers: number;
};

export type AppUser = {
  id: string;
  tenantId: string;
  authUserId: string;
  name: string;
  email: string;
  role: UserRole;
  course?: string;
  registration?: string;
  semester?: number;
};

export type AuthUserResponse = {
  id: string;
  name: string;
  email: string;
  role: ApiUserRole;
  tenantSlug: string;
};
