import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import { app } from '../app';
import * as supabase from '../config/supabase';
import { CoursesRepository } from '../modules/courses/courses.repository';
import { ClassesRepository } from '../modules/classes/classes.repository';
import { UsersRepository } from '../modules/users/users.repository';
import { InvitesRepository } from '../modules/invites/invites.repository';
import { activityCreateSchema } from '../modules/activities/activities.workflow.schemas';

const tenantId='11111111-1111-1111-1111-111111111111';
const base='/api/v1/tenants/edukmais';
function call(method:'get'|'patch',path:string) {
  return request(app)[method](`${base}${path}`).set('x-tenant-slug','edukmais').set('authorization','Bearer valid-admin-token');
}
afterEach(()=>jest.restoreAllMocks());

describe('stage9 verified regressions',()=>{
  it.each(['+99:99','+24:00','+00:99'])('rejects non-interpretable deadline offset %s on create and update',async offset=>{
    for(const [method,path]of [['post','/classes/class-teacher/activities'],['put','/activities/activity-teacher']]as const){
      const response=await request(app)[method](`${base}${path}`).set('x-tenant-slug','edukmais').set('authorization','Bearer valid-teacher-token')
        .send({title:'Synthetic deadline',dueDate:`2030-01-01T12:00:00${offset}`});
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    }
  });
  it.each(['-05:00','+03:30'])('preserves valid deadline offset %s as UTC',offset=>{
    const date=`2030-01-01T12:00:00${offset}`;
    expect(activityCreateSchema.parse({title:'Synthetic deadline',dueDate:date}).dueDate).toBe(new Date(date).toISOString());
  });
  it('maps the real PostgREST P0002 HTTP500 response to an absent invite',async()=>{
    const fetch=jest.fn(async()=>new Response(JSON.stringify({code:'P0002',message:'PRIVATE expired invite'}),{status:500,headers:{'content-type':'application/json'}}));
    const client=createClient('https://synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch}});
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(client);
    await expect(new InvitesRepository().accept('SYNTHETIC',{id:'synthetic-auth',email:'synthetic@example.invalid'},'Synthetic',tenantId)).rejects.toMatchObject({statusCode:404,code:'INVITE_NOT_FOUND',details:undefined});
  });
  it('counts active students independently from retained institutional users',async()=>{
    const db=supabase.createSupabaseAdminClient();
    await db.from('app_users').update({active:true}).eq('id','user-student');
    const before=await call('get','/reports/summary');
    expect(before.status).toBe(200);
    try {
      expect((await call('patch','/users/user-student/status').send({active:false})).status).toBe(200);
      const after=await call('get','/reports/summary');
      expect(after.status).toBe(200);expect(after.body.totalUsers).toBe(before.body.totalUsers);
      expect(after.body.activeStudents).toBe(before.body.activeStudents-1);
    } finally { await db.from('app_users').update({active:true}).eq('id','user-student'); }
  });
  it.each(['/users?page=1.5','/courses?limit=2.5','/courses/course-existing/classes?page=1e308&limit=100'])('rejects malformed legacy pagination in %s',async path=>{
    const response=await call('get',path);
    expect(response.status).toBe(400);expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });
  it.each(['users','courses','classes'] as const)('sends deterministic ordering to the real SDK for %s',async resource=>{
    const fetch=jest.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response('[]',{status:200,headers:{'content-type':'application/json','content-range':'*/0'}}));
    const client=createClient('https://synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch}});
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(client);
    const pagination={page:1,limit:20,offset:0};
    if(resource==='users')await new UsersRepository().list({tenantId,pagination});
    if(resource==='courses')await new CoursesRepository().list({tenantId,pagination});
    if(resource==='classes')await new ClassesRepository().listByCourse({tenantId,courseId:'synthetic-course',pagination});
    expect(fetch).toHaveBeenCalledTimes(1);
    const url=new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('order')).toBe('name.asc,id.asc');
  });
});
