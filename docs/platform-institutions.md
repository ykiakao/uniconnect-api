# P0.2 — instituições e bootstrap administrativo

Atualiza??o P0.3: [sess?es e contas](accounts-and-sessions.md) acrescenta prepara??o/convite de contas sem senha, reconcilia??o dur?vel e responsabilidade expl?cita. Bootstrap novo designa admin atomicamente; replays antigos conservam efeitos originais. Pend?ncias de refresh/recupera??o no texto hist?rico foram tratadas localmente; homologa??o remota permanece.


Contrato documentado antes da implementação no plano. Somente backend. Nenhum frontend, refresh, recuperação de senha, credencial ou Supabase remoto modificado. A gestão operacional não implementa cobrança/pagamentos.

## Autorização e endpoints

Prefixo `/api/v1/platform/institutions`, Bearer Supabase Auth e allowlist do servidor, independentes de app_users e do header x-tenant-slug. As capacidades da P0.1 foram ampliadas aditivamente: platform.reports.read permanece; platform.institutions.read/manage/bootstrap e platform.audit.read são novas. Não há seleção de ator/papel/capabilities pelo cliente. O superadmin não recebe acesso acadêmico automático.

| Método/caminho relativo | Capacidade | Entrada |
| --- | --- | --- |
| GET `/` | platform.institutions.read | page/limit; search por nome; operationalStatus active/suspended opcionais |
| GET `/:id` | platform.institutions.read | UUID da instituição |
| POST `/` | platform.institutions.manage | name, slug |
| PATCH `/:id` | platform.institutions.manage | name, expectedVersion |
| POST `/:id/suspend` | platform.institutions.manage | expectedVersion |
| POST `/:id/reactivate` | platform.institutions.manage | expectedVersion |
| POST `/:id/bootstrap-admin` | platform.institutions.bootstrap | name, email da conta Auth existente |
| GET `/:id/audit` | platform.audit.read | page/limit |

Nas mutações, `Idempotency-Key` é obrigatório e deve ser UUID; requestId de correlação é gerado pelo servidor, nunca aceito do corpo. Queries/corpos novos são estritos. Name1–200 sem controles; email normalizado/até254; slug min3/max63, minúsculo, começa por letra, alfanumérico com hífens internos. Slug é imutável nesta etapa. expectedVersion é inteiro1–2147483646.

Listas usam `{data,meta:{page,limit,total}}`, defaults1/20, limite100 e ordem estável por nome/id. Auditoria usa occurred_at/id. Não há DELETE de instituição, edição de assinatura/plano, importação ou provisionamento de credenciais.

Exemplo sintético de instituição (resposta de create/update/status e GET detalhe):

```json
{
  "id": "11111111-1111-1111-1111-111111111111",
  "name": "Instituicao Sintetica",
  "slug": "instituicao-sintetica",
  "operationalStatus": "active",
  "version": 1,
  "createdAt": "2026-10-31T12:00:00+00:00",
  "updatedAt": "2026-10-31T12:00:00+00:00"
}
```

POST create/bootstrap retorna201, inclusive replay; demais mutações200. Headers no-store/private e requestId, sanitização e rate limits preservados. Mutações de plataforma compartilham limite60/IP/minuto por processo, após autenticação; configuração de proxy/distribuição não foi alterada.

## Bootstrap sem alterações de credenciais

A restrição de não alterar credenciais foi resolvida vinculando **conta Auth já existente, única pelo email normalizado e confirmada**. A API não cria essa conta, não envia email, não redefine senha e não usa senha temporária no bootstrap. Conta ausente, não confirmada ou ambígua retorna409 com BOOTSTRAP_AUTH_REQUIRED/UNCONFIRMED/AMBIGUOUS e mensagem acionável. Sua provisão no ambiente real exige procedimento autorizado separado, fora desta execução.

O papel é fixo **admin**. Não se aceita role/authUserId/actor no corpo. Recusa instituição suspensa, gestor institucional existente (owner/admin/coordinator, inclusive inativo), alvo já vinculado e bootstrap previamente concluído. Não promove aluno/professor, não cria owner nem superadmin. O marcador durável continua impedindo uma segunda concessão inicial após alterações posteriores do usuário. Substituição/recuperação do responsável exige fluxo próprio futuro.

Resposta:

```json
{
  "institutionId": "11111111-1111-1111-1111-111111111111",
  "administrator": {
    "id": "22222222-2222-2222-2222-222222222222",
    "role": "admin",
    "active": true
  }
}
```

O vínculo, a auditoria e o journal são gravados na mesma transação PostgreSQL. Como Auth é somente consultado, falha de bootstrap não deixa conta Auth nova órfã. Falhas/restrições externas podem ser corrigidas e a mesma chave repetida quando a primeira tentativa não commitou. Após commit com resposta perdida, repetir a mesma chave recupera o resultado original, sem criar outro vínculo/evento.

O cadastro institucional legado de usuários continua sendo outro fluxo: Auth pode ser criado antes da RPC do vínculo. Não foi transformado em transação distribuída nem recebeu promessa de eliminação de todo órfão legado. Ele conserva a recuperação/reutilização de conta existente; falhas entre Auth e SQL continuam pendência operacional. Os textos antes aceitos nesse cadastro não foram restringidos pela nova RPC. A validação estrita acima aplica-se aos novos endpoints de plataforma/bootstrap.

## Idempotência, versão e auditoria

Journal vincula ator Auth + chave + operação + SHA256 do payload canônico JSONB; não guarda senha/email/payload bruto. Mesma chave com payload/operação diferente retorna409. A chave do atorA não recupera resultado do atorB. Falha SQL reverte journal e efeitos; concorrência se serializa na chave e na instituição.

Atualizações exigem expectedVersion; versão obsoleta retorna409 sem sobrescrever estado. Mesmo status solicitado com nova chave/version válida incrementa versão e audita. Um replay devolve **a fotografia da resposta original**, que pode estar desatualizada; não reaplica status nem reativa instituição posteriormente suspensa. Consultar GET detalhe para obter o estado atual antes de nova mutação.

Auditoria durável/atribuível é transacional: criação, edição, suspensão, reativação, bootstrap e concessões administrativas institucionais via API (criação/mudança de papel e aceitação de convite admin/coordinator). Campos: ator Auth, ação, requestId do servidor, tenant/alvo, estados anterior/novo e data. Não armazena email, senha, nome de usuário, conteúdo acadêmico ou corpo HTTP completo. Na concessão por convite, o ator da concessão é o emissor revalidado; correlation é da requisição de aceitação.

Audit/journal têm RLS e ACLs restritas. service_role pode ler auditoria, não inserir/atualizar/apagar/truncar diretamente; RPCs privadas SECURITY DEFINER de search_path fixo gravam como owner. Triggers bloqueiam UPDATE/DELETE/TRUNCATE de eventos. Isso não é proteção contra um DBA/owner que altere deliberadamente schema/permissões; service key permanece segredo do backend. A allowlist é aplicada na API, sem cópia de privilégios globais em app_users ou papéis enviados pelo cliente.

## Suspensão e sessões existentes

`tenants.operational_status` active/suspended é independente de status/plan legados. Migration inicializa instituições existentes como active, preservando assinatura/dados. Somente a API de plataforma autoriza alteração operacional; endpoints institucionais não aceitam esses campos.

O relatório global legado mantém suas contagens anteriores: activeTenants usa o status de assinatura active. Para quantidade operacional, usar a listagem nova filtrada por operationalStatus e seu meta.total; não interpretar a contagem legada como prova de acesso operacional.

TenantRepository verifica o estado ao resolver instituição, antes de login e requisições institucionais: token já emitido não evita403 TENANT_SUSPENDED. Convites públicos derivam tenant do código e verificam estado antes de criar/autenticar conta, sem depender do header. A RPC de aceitação também protege a operação após locks, impedindo consumo/vínculo em instituição suspensa.

Os22 conjuntos de tabelas institucionais existentes possuem guard SQL de escrita com lock compartilhado no tenant. Suspensão usa lock exclusivo na linha: escritas anteriores completam antes dela; posteriores aguardam e revalidam o estado. APIs de plataforma e sua auditoria continuam operáveis durante suspensão. Reativação não recria matrículas, não altera Auth/papéis e não apaga histórico.

Leituras já iniciadas antes da suspensão podem terminar; não há cancelamento retroativo de respostas ou ban global do usuário Auth. Outro vínculo institucional ativo da mesma identidade continua válido. Cópias já baixadas e acesso administrativo direto ao banco não são revogados por este mecanismo.

## Migration e aplicação futura

Nova: `supabase/migrations/20261031000006_platform_institutions.sql`. Depende de schema + bases e00001→00005. Não altera arquivos históricos. Manifesto ampliado para dez fontes; novo SHA256 normalizado CRLF→LF: `44eb3aff6b12bcba67567e4811b7dd4e2289c7e46b2bb62beaf68c17a5b49011`.

A migration adiciona colunas operacionais, journal/auditoria e RPCs/guards. O convite antigo é renomeado para helper privado sem EXECUTE das roles de API; wrapper de mesmo nome público lógico aceita requestId adicional. Chamadas antigas4args de convite aluno/professor continuam resolvendo pelo default; convites administrativos requerem correlation e a API atual envia esse parâmetro.

Antes de qualquer aplicação real: concluir inventário10.2, reconciliar ledger/checksums/customizações e dados, qualificar backup/restore, ensaiar em destino isolado e obter autorização específica10.3. Selecionar somente arquivos comprovadamente pendentes, usando o executor protegido. Não enviar SQL bruto via SQL Editor/psql/CLI e não usar setup/seed para upgrade de banco existente.

Exige janela de manutenção: DDL/locks e troca da API devem ser coordenados; os gates novos dependem da coluna/RPC. Ausência da nova estrutura retorna503 DATABASE_MIGRATION_REQUIRED quando identificável, sem fallback para aceitar instituição de estado desconhecido. SQLstatePT403 é traduzido em403 TENANT_SUSPENDED. Outros erros internos não expõem SQL/stack/credenciais. Em erro de aplicação, verificar rollback/estado da sessão e ledger antes de retomar; o executor não reconcilia automaticamente histórico remoto.

Nada disso foi executado no Supabase remoto. Validação PostgreSQL/HTTP real nesta etapa usa somente containers descartáveis, loopback e identidades sintéticas; Auth do harness é sintético, não homologação de GoTrue.

## Próxima etapa

P0.3: refresh/recuperação de senha, ciclo de vida/provisão autorizada de contas e substituição do responsável, qualificação operacional/proxy/rate limit, inventário remoto autorizado e integração dos clientes conforme escopo aprovado. Nenhuma dessas atividades começa automaticamente ao encerrar P0.2.
