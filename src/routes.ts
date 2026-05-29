import { Router } from 'express';

import { authRoutes } from './modules/auth/auth.routes';
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
  globalReportsRoutes,
  tenantReportsRoutes,
} from './modules/reports/reports.routes';
import { tenantRoutes } from './modules/tenants/tenant.routes';
import { usersRoutes } from './modules/users/users.routes';

export const routes = Router();

routes.use('/auth', authRoutes);
routes.use('/admin', globalReportsRoutes);
routes.use('/tenants/:slug/classes/:classId/activities', classActivitiesRoutes);
routes.use('/tenants/:slug/courses/:courseId/classes', courseClassesRoutes);
routes.use('/tenants/:slug/activities/:activityId/grades', activityGradesRoutes);
routes.use('/tenants/:slug/activities', activitiesRoutes);
routes.use('/tenants/:slug/students', studentGradesRoutes);
routes.use('/tenants/:slug/reports', tenantReportsRoutes);
routes.use('/tenants/:slug/classes', classesRoutes);
routes.use('/tenants/:slug/courses', coursesRoutes);
routes.use('/tenants/:slug/users', usersRoutes);
routes.use('/tenants', tenantRoutes);
