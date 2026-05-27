export type UserRole = 'student' | 'teacher' | 'admin';

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
  name: string;
  email: string;
  role: UserRole;
  course?: string;
  registration?: string;
  semester?: number;
};
