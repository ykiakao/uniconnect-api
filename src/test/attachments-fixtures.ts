import { randomUUID } from 'node:crypto';
import { StoredFile } from '../modules/attachments/attachments.schemas';
import { AppUser } from '../shared/types';
export const attachmentTenant = '11111111-1111-1111-1111-111111111111';
export const attachmentUser: AppUser = { id: 'user-student', tenantId: attachmentTenant, authUserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'student', active: true, name: 'Synthetic', email: 'synthetic@example.invalid' };
export function storedAttachment(overrides: Partial<StoredFile> = {}): StoredFile {
  const id=randomUUID(),activity=randomUUID(),lease=randomUUID();
  return {
    id,tenant_id:attachmentTenant,activity_id:activity,activity_scope_id:activity,created_by:attachmentUser.id,purpose:'submission',
    original_name:'sample.pdf',declared_type:'application/pdf',declared_size:100,bucket:'academic-attachments',
    staging_path:`staging/${attachmentTenant}/${activity}/${id}/${randomUUID()}`,candidate_paths:[],candidate_path:null,final_path:null,
    state:'pending',sha256:null,size_bytes:null,content_type:null,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+7200000).toISOString(),upload_expires_at:null,lease_token:lease,lease_until:null,
    ...overrides,
  };
}
export function readyAttachment(file=storedAttachment()): StoredFile {
  const path=file.candidate_path??`files/${file.tenant_id}/${file.activity_scope_id}/${file.id}/${randomUUID()}.pdf`;
  return {...file,state:'ready',candidate_path:path,candidate_paths:[...new Set([...file.candidate_paths,path])],final_path:path,sha256:'a'.repeat(64),size_bytes:100,content_type:'application/pdf',lease_token:null,lease_until:null};
}
