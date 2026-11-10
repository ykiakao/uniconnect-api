import { checkSupabaseAvailability, checkQueryError, requireRows, requireCount } from '../../shared/supabase-errors';
import { Pagination } from '../../shared/pagination';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { UsersRepository } from '../users/users.repository';

type GradeRow = {
  id: string;
  tenant_id: string;
  activity_id: string;
  student_id: string;
  grade: number | null;
  feedback: string | null;
  graded_at: string | null;
  graded_by: string | null;
};

type StudentRow = {
  auth_user_id: string;
  name: string;
};

type ActivityRow = {
  id: string;
  title: string;
  class_id: string;
  state?: string;
};

type ClassRow = {
  id: string;
  teacher_id: string | null;
};

const gradeSelect =
  'id,tenant_id,activity_id,student_id,grade,feedback,graded_at,graded_by';

export class GradesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async listAcademicAssessments(params: { tenantId: string; studentAuthUserId: string; activityIds: string[]; pagination: Pagination }) {
    if (!params.activityIds.length) return { grades: [], total: 0 };
    const { data, error, status, count } = await this.supabase.from('grades')
      .select(gradeSelect, { count: 'exact' }).eq('tenant_id', params.tenantId).eq('student_id', params.studentAuthUserId)
      .eq('publication_state','published').eq('grade_unit','score_0_10')
      .in('activity_id', params.activityIds).order('id').range(params.pagination.offset, params.pagination.offset + params.pagination.limit - 1);
    checkQueryError(error, status);
    return { grades: requireRows(data).map(row => {
      const grade = row as GradeRow;
      return { activityId: grade.activity_id, grade: grade.grade, feedback: grade.feedback ?? undefined, gradedAt: grade.graded_at };
    }), total: requireCount(count) };
  }

  async listByActivity(params: { tenantId: string; activityId: string }) {
    const { data, error, status } = await this.supabase
      .from('grades')
      .select(gradeSelect)
      .eq('tenant_id', params.tenantId)
      .eq('activity_id', params.activityId)
      .eq('grade_unit', 'score_0_10');

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'GRADES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar notas.',
        error.message,
      );
    }

    const students = await this.listStudents(params.tenantId);
    const studentsByAuthId = new Map(
      students.map((student) => [student.auth_user_id, student]),
    );

    return requireRows(data).map((row) => {
      const grade = row as GradeRow;
      const student = studentsByAuthId.get(grade.student_id);

      return {
        studentId: grade.student_id,
        studentName: student?.name ?? '',
        grade: grade.grade,
        feedback: grade.feedback ?? undefined,
      };
    });
  }

  async upsert(params: {
    tenantId: string;
    activityId: string;
    studentId: string;
    grade: number;
    feedback?: string;
    gradedBy: string;
  }) {
    const studentAuthUserId = await this.resolveStudentAuthUserId({
      tenantId: params.tenantId,
      studentId: params.studentId,
    });
    const now = new Date().toISOString();

    const { data, error, status } = await this.supabase
      .from('grades')
      .upsert({
        tenant_id: params.tenantId,
        activity_id: params.activityId,
        student_id: studentAuthUserId,
        grade: params.grade,
        feedback: params.feedback,
        graded_at: now,
        graded_by: params.gradedBy,
      }, { onConflict: 'tenant_id,activity_id,student_id' })
      .select(gradeSelect)
      .single<GradeRow>();

    if (error?.code === '42P10') {
      throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao de integridade do banco pendente.');
    }
    if (error && ['23503', '23514'].includes(error.code)) {
      throw new HttpError(409, 'GRADE_INTEGRITY_CONFLICT', 'O vinculo academico mudou. Verifique os dados antes de tentar novamente.');
    }
    checkSupabaseAvailability(error, status);
    if (error || !data) {
      throw new HttpError(
        500,
        'GRADE_CREATE_FAILED',
        'NÃ£o foi possÃ­vel registrar nota.',
        error?.message,
      );
    }

    return this.mapGrade(data);
  }

  async listByStudent(params: {
    tenantId: string;
    studentId: string;
    teacherAuthUserId?: string;
    classIds?: string[];
    publishedOnly?: boolean;
  }) {
    const studentAuthUserId = await this.resolveStudentAuthUserId({
      tenantId: params.tenantId,
      studentId: params.studentId,
    });

    let query = this.supabase
      .from('grades')
      .select(gradeSelect)
      .eq('tenant_id', params.tenantId)
      .eq('student_id', studentAuthUserId)
      .eq('grade_unit', 'score_0_10');
    if (params.publishedOnly) query=query.eq('publication_state','published');
    const { data,error,status }=await query;

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'STUDENT_GRADES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar notas do aluno.',
        error.message,
      );
    }

    const activities = await this.listActivities(params.tenantId);
    const classes = await this.listClasses(params.tenantId);
    const activitiesById = new Map(
      activities.map((activity) => [activity.id, activity]),
    );
    const classesById = new Map(classes.map((classRow) => [classRow.id, classRow]));

    return requireRows(data)
      .map((row) => row as GradeRow)
      .filter((grade) => {
        if (params.publishedOnly) {
          const activity=activitiesById.get(grade.activity_id);
          if (!activity||activity.state==='draft') return false;
        }
        if (params.classIds) {
          const activity = activitiesById.get(grade.activity_id);
          return !!activity && params.classIds.includes(activity.class_id);
        }
        if (!params.teacherAuthUserId) return true;
        const activity = activitiesById.get(grade.activity_id);
        const classRow = activity ? classesById.get(activity.class_id) : undefined;
        return classRow?.teacher_id === params.teacherAuthUserId;
      })
      .map((grade) => {
        const activity = activitiesById.get(grade.activity_id);

        return {
          activityId: grade.activity_id,
          title: activity?.title ?? '',
          grade: grade.grade,
          feedback: grade.feedback ?? undefined,
        };
      });
  }

  private async resolveStudentAuthUserId(params: {
    tenantId: string;
    studentId: string;
  }) {
    const student = await new UsersRepository().findAcademicMember({
      tenantId: params.tenantId, identifier: params.studentId, role: 'student',
    });
    return student.authUserId;
  }

  private async listStudents(tenantId: string) {
    const { data, error, status } = await this.supabase
      .from('app_users')
      .select('auth_user_id,name')
      .eq('tenant_id', tenantId)
      .eq('role', 'student');

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'STUDENTS_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar alunos.',
        error.message,
      );
    }

    return requireRows(data) as StudentRow[];
  }

  private async listActivities(tenantId: string) {
    const { data, error, status } = await this.supabase
      .from('activities')
      .select('id,title,class_id,state')
      .eq('tenant_id', tenantId);

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'ACTIVITIES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar atividades.',
        error.message,
      );
    }

    return requireRows(data) as ActivityRow[];
  }

  private async listClasses(tenantId: string) {
    const { data, error, status } = await this.supabase
      .from('classes')
      .select('id,teacher_id')
      .eq('tenant_id', tenantId);

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'CLASSES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar turmas.',
        error.message,
      );
    }

    return requireRows(data) as ClassRow[];
  }

  private mapGrade(row: GradeRow) {
    return {
      studentId: row.student_id,
      grade: row.grade,
      feedback: row.feedback ?? undefined,
      gradedAt: row.graded_at,
    };
  }
}
