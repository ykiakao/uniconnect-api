import { checkSupabaseAvailability, requireRows, requireCount } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';

type CountFilter = {
  column: string;
  value: string | boolean;
};

type ActivityRow = {
  id: string;
  class_id: string;
  created_at: string;
  due_date: string | null;
};

type ClassRow = {
  id: string;
  course_id: string;
};

export class ReportsRepository {
  private readonly supabase = createSupabaseAdminClient();

  async summary(tenantId: string) {
    const [totalUsers, totalCourses, totalClasses, activeStudents] =
      await Promise.all([
        this.count('app_users', [{ column: 'tenant_id', value: tenantId }]),
        this.count('courses', [{ column: 'tenant_id', value: tenantId }]),
        this.count('classes', [{ column: 'tenant_id', value: tenantId }]),
        this.count('app_users', [
          { column: 'tenant_id', value: tenantId },
          { column: 'role', value: 'student' },
          { column: 'active', value: true },
        ]),
      ]);

    return {
      totalUsers,
      totalCourses,
      totalClasses,
      activeStudents,
    };
  }

  async engagement(params: {
    tenantId: string;
    from?: string;
    to?: string;
    courseId?: string;
  }) {
    const { data, error, status } = await this.supabase
      .from('activities')
      .select('id,class_id,created_at,due_date')
      .eq('tenant_id', params.tenantId);

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'ENGAGEMENT_REPORT_FAILED',
        'NÃ£o foi possÃ­vel gerar relatÃ³rio de engajamento.',
        error.message,
      );
    }

    const allowedClassIds = params.courseId
      ? await this.listClassIdsByCourse({
          tenantId: params.tenantId,
          courseId: params.courseId,
        })
      : undefined;

    const fromTime = params.from ? new Date(params.from).getTime() : undefined;
    const toTime = params.to ? new Date(params.to).getTime() : undefined;
    const grouped = new Map<string, number>();

    requireRows(data)
      .map((row) => row as ActivityRow)
      .filter((activity) => {
        if (allowedClassIds && !allowedClassIds.has(activity.class_id)) {
          return false;
        }

        const timestamp = new Date(
          activity.due_date ?? activity.created_at,
        ).getTime();

        if (fromTime && timestamp < fromTime) return false;
        if (toTime && timestamp > toTime) return false;
        return true;
      })
      .forEach((activity) => {
        const label = (activity.due_date ?? activity.created_at).slice(0, 10);
        grouped.set(label, (grouped.get(label) ?? 0) + 1);
      });

    const labels = [...grouped.keys()].sort();

    return {
      labels,
      values: labels.map((label) => grouped.get(label) ?? 0),
    };
  }

  async global() {
    const [totalTenants, totalUsers, activeTenants] = await Promise.all([
      this.count('tenants'),
      this.count('app_users'),
      this.count('tenants', [{ column: 'status', value: 'active' }]),
    ]);

    return {
      totalTenants,
      totalUsers,
      activeTenants,
    };
  }

  private async count(table: string, filters: CountFilter[] = []) {
    let query = this.supabase.from(table).select('id', { count: 'exact' });

    for (const filter of filters) {
      query = query.eq(filter.column, filter.value);
    }

    const { count, error, status } = await query;

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'REPORT_COUNT_FAILED',
        'NÃ£o foi possÃ­vel calcular relatÃ³rio.',
        error.message,
      );
    }

    return requireCount(count);
  }

  private async listClassIdsByCourse(params: {
    tenantId: string;
    courseId: string;
  }) {
    const { data, error, status } = await this.supabase
      .from('classes')
      .select('id,course_id')
      .eq('tenant_id', params.tenantId)
      .eq('course_id', params.courseId);

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'COURSE_CLASSES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar turmas do curso.',
        error.message,
      );
    }

    return new Set(requireRows(data).map((row) => (row as ClassRow).id));
  }
}
