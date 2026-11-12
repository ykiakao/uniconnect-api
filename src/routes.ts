import { Router } from 'express';
import { structureRoutes } from './modules/academic-structure/academic-structure.routes';
import { Resources } from './modules/academic-structure/academic-structure.schemas';
import { env } from './config/env';
import { academicAttachmentsRoutes } from './modules/attachments/attachments.routes';
import { RouteRegistry } from './observability/route-registry';

import { authRoutes } from './modules/auth/auth.routes';
import { platformAuthRoutes } from './modules/auth/platform-auth.routes';
import { publicRecoveryRoutes } from './modules/auth/recovery.routes';
import { platformInstitutionsRoutes } from './modules/tenants/platform-institutions.routes';
import { platformAccountsRoutes } from './modules/tenants/platform-accounts.routes';
import { noticesRoutes, conversationsRoutes, notificationsRoutes } from './modules/communication/communication.routes';
import { activitySubmissionsRoutes,submissionsRoutes } from './modules/activities/activities.submissions.routes';
import { examGradesRoutes } from './modules/grades/exam-grades.routes';
import { academicReportCardRoutes } from './modules/grades/academic-report-card.routes';
import { academicRoutes } from './modules/academic/academic.routes';
import {
  activitiesRoutes,
  classActivitiesRoutes,
} from './modules/activities/activities.routes';
import {
  classesRoutes,
  courseClassesRoutes,
} from './modules/classes/classes.routes';
import { coursesRoutes } from './modules/courses/courses.routes';
import {
  activityGradesRoutes,
  studentGradesRoutes,
} from './modules/grades/grades.routes';
import {
  publicInvitesRoutes,
  tenantInvitesRoutes,
} from './modules/invites/invites.routes';
import {
  globalReportsRoutes,
  tenantReportsRoutes,
} from './modules/reports/reports.routes';
import { tenantRoutes } from './modules/tenants/tenant.routes';
import { usersRoutes } from './modules/users/users.routes';

export const routes = Router();
export const platformRoutes = Router();
export const routeRegistry = new RouteRegistry();

function mount(path: string, router: Router, target = routes) {
  for (const layer of router.stack) {
    const route = layer.route as { path?: unknown; methods?: Record<string, boolean> } | undefined;
    if (typeof route?.path !== 'string') continue;
    for (const method of Object.keys(route.methods ?? {})) {
      routeRegistry.register(method, `/api/${env.API_VERSION}${path}${route.path === '/' ? '' : route.path}`);
    }
  }
  target.use(path, router);
}

mount('/auth', authRoutes);
mount('/auth/platform', platformAuthRoutes, platformRoutes);
mount('/auth', publicRecoveryRoutes, platformRoutes);
mount('/platform/institutions/:institutionId', platformAccountsRoutes, platformRoutes);
mount('/platform/institutions', platformInstitutionsRoutes, platformRoutes);
mount('/tenants/:slug/notices', noticesRoutes);
mount('/tenants/:slug', academicAttachmentsRoutes);
mount('/tenants/:slug/conversations', conversationsRoutes);
mount('/tenants/:slug/notifications', notificationsRoutes);
mount('/tenants/:slug/activities/:activityId/submissions',activitySubmissionsRoutes);
mount('/tenants/:slug/submissions',submissionsRoutes);
for (const resource of Resources) mount(`/tenants/:slug/${resource}`, structureRoutes(resource));
mount('/tenants/:slug/academic', academicRoutes);
mount('/admin', globalReportsRoutes, platformRoutes);
mount('/invites', publicInvitesRoutes);
mount('/tenants/:slug/invites', tenantInvitesRoutes);
mount('/tenants/:slug/classes/:classId/activities', classActivitiesRoutes);
mount('/tenants/:slug/classes/:classId/report-card', academicReportCardRoutes);
mount('/tenants/:slug/courses/:courseId/classes', courseClassesRoutes);
mount('/tenants/:slug/activities/:activityId/grades', activityGradesRoutes);
mount('/tenants/:slug/activities/:activityId/exam', examGradesRoutes);
mount('/tenants/:slug/activities', activitiesRoutes);
mount('/tenants/:slug/students', studentGradesRoutes);
mount('/tenants/:slug/reports', tenantReportsRoutes);
mount('/tenants/:slug/classes', classesRoutes);
mount('/tenants/:slug/courses', coursesRoutes);
mount('/tenants/:slug/users', usersRoutes);
mount('/tenants', tenantRoutes);
