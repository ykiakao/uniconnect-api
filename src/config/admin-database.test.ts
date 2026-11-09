import { ensureUninitializedAdminDatabase } from './admin-database';

describe('safe administrative bootstrap boundary',()=>{
  it('checks only metadata and allows an empty schema',async()=>{
    const query=jest.fn(async(_sql:string)=>({rows:[{initialized:false}]}));
    await expect(ensureUninitializedAdminDatabase({query})).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('pg_catalog.pg_class');
    expect(query.mock.calls[0][0]).not.toMatch(/\b(insert|update|delete|alter|drop|create)\b/i);
  });
  it('refuses an existing installation before any schema or migration write',async()=>{
    const query=jest.fn(async(_sql:string)=>({rows:[{initialized:true}]}));
    await expect(ensureUninitializedAdminDatabase({query})).rejects.toThrow('inicializado');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('fails closed on an unexpected metadata result or database failure',async()=>{
    await expect(ensureUninitializedAdminDatabase({query:async()=>({rows:[]})})).rejects.toThrow();
    await expect(ensureUninitializedAdminDatabase({query:async()=>{throw new Error('Synthetic query failure');}})).rejects.toThrow('Synthetic query failure');
  });
});
