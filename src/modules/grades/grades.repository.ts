import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';

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
};

type ClassRow = {
  id: string;
  teacher_id: string | null;
};

const gradeSelect =
  'id,tenant_id,activity_id,student_id,grade,feedback,graded_at,graded_by';

export class GradesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async listByActivity(params: { tenantId: string; activityId: string }) {
    const { data, error } = await this.supabase
      .from('grades')
      .select(gradeSelect)
      .eq('tenant_id', params.tenantId)
      .eq('activity_id', params.activityId);

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

    return (data ?? []).map((row) => {
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
    const existing = await this.findExistingGrade({
      ...params,
      studentId: studentAuthUserId,
    });
    const now = new Date().toISOString();

    if (existing) {
      const { data, error } = await this.supabase
        .from('grades')
        .update({
          grade: params.grade,
          feedback: params.feedback,
          graded_at: now,
          graded_by: params.gradedBy,
        })
        .eq('tenant_id', params.tenantId)
        .eq('id', existing.id)
        .select(gradeSelect)
        .single<GradeRow>();

      if (error || !data) {
        throw new HttpError(
          500,
          'GRADE_UPDATE_FAILED',
          'NÃ£o foi possÃ­vel atualizar nota.',
          error?.message,
        );
      }

      return this.mapGrade(data);
    }

    const { data, error } = await this.supabase
      .from('grades')
      .insert({
        tenant_id: params.tenantId,
        activity_id: params.activityId,
        student_id: studentAuthUserId,
        grade: params.grade,
        feedback: params.feedback,
        graded_at: now,
        graded_by: params.gradedBy,
      })
      .select(gradeSelect)
      .single<GradeRow>();

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
  }) {
    const studentAuthUserId = await this.resolveStudentAuthUserId({
      tenantId: params.tenantId,
      studentId: params.studentId,
    });

    const { data, error } = await this.supabase
      .from('grades')
      .select(gradeSelect)
      .eq('tenant_id', params.tenantId)
      .eq('student_id', studentAuthUserId);

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

    return (data ?? [])
      .map((row) => row as GradeRow)
      .filter((grade) => {
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

  private async findExistingGrade(params: {
    tenantId: string;
    activityId: string;
    studentId: string;
  }) {
    const { data } = await this.supabase
      .from('grades')
      .select(gradeSelect)
      .eq('tenant_id', params.tenantId)
      .eq('activity_id', params.activityId)
      .eq('student_id', params.studentId)
      .single<GradeRow>();

    return data;
  }

  private async resolveStudentAuthUserId(params: {
    tenantId: string;
    studentId: string;
  }) {
    const { data } = await this.supabase
      .from('app_users')
      .select('auth_user_id')
      .eq('tenant_id', params.tenantId)
      .eq('id', params.studentId)
      .single<{ auth_user_id: string }>();

    return data?.auth_user_id ?? params.studentId;
  }

  private async listStudents(tenantId: string) {
    const { data, error } = await this.supabase
      .from('app_users')
      .select('auth_user_id,name')
      .eq('tenant_id', tenantId)
      .eq('role', 'student');

    if (error) {
      throw new HttpError(
        500,
        'STUDENTS_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar alunos.',
        error.message,
      );
    }

    return (data ?? []) as StudentRow[];
  }

  private async listActivities(tenantId: string) {
    const { data, error } = await this.supabase
      .from('activities')
      .select('id,title,class_id')
      .eq('tenant_id', tenantId);

    if (error) {
      throw new HttpError(
        500,
        'ACTIVITIES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar atividades.',
        error.message,
      );
    }

    return (data ?? []) as ActivityRow[];
  }

  private async listClasses(tenantId: string) {
    const { data, error } = await this.supabase
      .from('classes')
      .select('id,teacher_id')
      .eq('tenant_id', tenantId);

    if (error) {
      throw new HttpError(
        500,
        'CLASSES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar turmas.',
        error.message,
      );
    }

    return (data ?? []) as ClassRow[];
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
