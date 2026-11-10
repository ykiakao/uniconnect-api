# P0.3 — sessões e contas administrativas

Contrato de01/11/2026, prefixo `/api/v1`. Somente validação local; nenhum acesso ao Supabase remoto, envio de email real ou alteração de credenciais. Login/me institucionais e de plataforma conservam URLs e JSON. Capabilities globais adicionais: `platform.accounts.provision`, `platform.institutions.responsible.manage`. `owner` permanece institucional.

## Sessões e recuperação

| Método e caminho | Entrada JSON estrita | Autorização e resultado |
| --- | --- | --- |
| POST `/auth/refresh` | `{refreshToken}` | Tenant obrigatório; vínculo ativo atual;200 com JSON do login institucional |
| POST `/auth/admin/refresh` | `{refreshToken}` | Tenant e papel atual owner/admin/coordinator;200 com JSON do login administrativo |
| POST `/auth/platform/refresh` | `{refreshToken}` | Auth e allowlist atuais; nenhum tenant/app_users;200 com JSON do login global |
| POST `/auth/password/recovery` | `{email}` | Público, sem tenant;202 com mensagem genérica |
| POST `/auth/password/reset` | `{tokenHash,newPassword}` | Prova oficial recovery;204 sem sessão na resposta |
| POST `/auth/accounts/activate` | `{tokenHash,newPassword}` | Prova oficial invite;204 sem sessão na resposta |

Refresh tem limite8192caracteres; tokenHash2048; senha8–128. Inputs extras, query, Authorization e headers refresh-token/x-refresh-token são rejeitados nesses endpoints. Enviar provas apenas no corpo JSON, nunca na URL. JWT comum não substitui prova de recuperação. Nos demais endpoints, Bearer continua funcionando normalmente.

Cada operação cria um cliente SDK isolado com autoRefreshToken/persistSession desativados. persistSession:false sozinho não elimina sessão em memória; por isso recuperação/ativação/refresh não compartilham cliente. Refresh usa `refreshSession`, valida novo access token por `getUser`, confere identidade e relê vínculo/estado/papel; plataforma relê allowlist. Tenant é verificado antes e depois da rotação. Suspensão, vínculo inativo, tenant divergente ou perda do papel administrativo negam a sessão. Uma negativa após rotação pode consumir o refresh anterior e exigir login. Não fazemos logout global para corrigir negativa de um tenant e atingir outro vínculo.

Tokens continuam exclusivamente do Supabase. Rejeições conhecidas por sessão/token expirado, revogado, inválido ou reutilizado retornam401 INVALID_SESSION. Não implementamos replay próprio nem garantimos recusa de toda reutilização: o provedor tem exceções de reutilização/concorrência. Homologar comportamento/configuração reais separadamente.

Recuperação retorna a mesma mensagem202 para conta existente/inexistente e rejeições de conta conhecidas: `{"message":"Se a conta puder receber emails, enviaremos as instrucoes de recuperacao."}`. Não consultamos existência antes do envio. Limites locais são uniformes por IP. Falha de infraestrutura/serviço ou configuração ausente retorna503 sanitizado, sem falso sucesso. Não há promessa de indistinguibilidade de tempo de rede/SMTP nem alteração das políticas internas do provedor.

Reset/ativação: `verifyOtp` com tipo fixo, validação por `getUser`, `updateUser({password})` na sessão verificada, `signOut({scope:'global'})`. Não usam reset administrativo nem tabelas próprias de senha/prova. Se senha mudar e revogação falhar:503 PASSWORD_CHANGED_REVOCATION_FAILED informa efeito parcial, sem fingir rollback. Prova consumida antes de falha posterior pode exigir novo fluxo/email. JWTs já emitidos podem permanecer válidos até expiração conforme o provedor; não prometemos invalidação instantânea universal. Gates institucionais/allowlist permanecem por requisição.

## Configuração externa e futuro cliente

Opções em `.env.example`, sem modificar `.env` existente:

- `AUTH_RECOVERY_REDIRECT_URL`: destino fixo de recuperação, necessário apenas ao pedir email.
- `AUTH_INVITE_REDIRECT_URL`: destino fixo de ativação, necessário antes de reservar/retomar provisionamento.

HTTPS, sem userinfo/query/fragment; HTTP somente loopback fora de produção. Cliente não escolhe redirect. Configurar separadamente URLs permitidas/Site URL, SMTP e templates Recovery/Invite no Supabase autorizado. Não colocar senha/token/segredo em configuração ou logs.

Templates precisam entregar `{{ .TokenHash }}` ao futuro cliente, sem consumir automaticamente a prova via ConfirmationURL antes do envio à API. Uma opção é link com `{{ .RedirectTo }}` e prova em fragmento, que não é enviado ao servidor HTTP. O cliente deverá ler em memória, remover fragmento do histórico, obter nova senha e enviar JSON ao endpoint correto sem Authorization e sem persistir prova/token em storage. Essa interface e os templates remotos **não foram implementados/configurados**; não aplicar template assim sem cliente capaz de completá-lo. Após204, realizar login normal. Flutter/web atuais não foram modificados.

## Provisionamento global em duas fases

Base `/platform/institutions/:institutionId`. Bearer/allowlist obrigatórios, sem depender de vínculo institucional. Capacidade platform.accounts.provision. Papéis institucionais/headers/body nunca concedem contexto global.

| Método e sufixo | Entrada/resultado |
| --- | --- |
| POST `/admin-provisioning` | `{name,email}` + Idempotency-Key UUID;202 com recibo |
| GET `/admin-provisioning` | page/limit; paginação padrão, campos mínimos |
| GET `/admin-provisioning/:provisionId` | Recibo escopado à instituição |
| POST `/admin-provisioning/:provisionId/resume` | `{}`;202 com estado reconciliado |

Recibo `{id,institutionId,state,createdAt,updatedAt}`. Estados pending/invite_requested/awaiting_confirmation/ready/needs_review. Sem nome/email no recibo. `ready` significa identidade Auth única e confirmada, **sem vínculo ou autorização institucional automáticos**.

1. RPC persiste intenção por tenant/email normalizado e journal ator+chave+operação+hash do payload. Repetição não duplica identidade/vínculo; chave reutilizada com payload/operação diferente retorna409. Nome divergente para mesma instituição/email conflita.
2. Preparação procura Auth por email e confere identidade anteriormente associada. Confirmada vira ready; não confirmada vira awaiting_confirmation, sem sobrescrever senha/metadados.
3. Se não existir conta, SQL registra claim de tentativa e auditoria antes de `admin.inviteUserByEmail`. SDK recebe email/redirect do servidor, sem papel/senha.
4. Resultado é reconciliado com Auth no banco. Falha de rede, resposta inconsistente ou checkpoint incerto retorna503 ACCOUNT_PROVISIONING_PENDING; consultar recibo e chamar resume. Repetição não reenvia email automaticamente.
5. Sem identidade após tentativa incerta: needs_review. Investigar pelo ID e auditoria; não apagar conta Auth, editar flags no banco ou repetir convite às cegas. Operador autorizado deverá qualificar resultado no provedor e decidir eventual reenvio em fluxo operacional separado, ainda não automatizado. Queda entre claim e envio pode exigir intervenção.
6. Após confirmação, usar explicitamente bootstrap-admin P0.2 ou substituição abaixo. Preparar/confirmar email sozinho não concede privilégios.

Não há promessa de transação distribuída/exactly-once SMTP. Conta criada fica atribuída à intenção durável, sem acesso institucional até vínculo autorizado. Não fazemos compensação destrutiva de conta compartilhável com outros tenants. Cadastro institucional legado permanece fora desse fluxo; sua falha parcial Auth→vínculo/reutilização conserva as limitações da P0.2.

## Responsável institucional explícito

| Método e sufixo | Entrada/resultado |
| --- | --- |
| GET `/responsible` | `{institutionId,responsibleUserId,version}` ou404 RESPONSIBLE_NOT_DESIGNATED |
| POST `/responsible/designate` | `{administratorId,expectedVersion:0}` + Idempotency-Key;200 |
| POST `/responsible/replace` | `{name,email,expectedVersion}` + Idempotency-Key;200 |
| GET `/responsible/history` | page/limit; ator/requestId, usuários anterior/novo |

Leitura/mutações exigem platform.institutions.responsible.manage; histórico exige platform.audit.read. Identificador enviado é alvo, nunca privilégio. Responsável deve ser admin ativo no tenant. Bootstrap novo designa esse admin na mesma transação, mantendo JSON/operational_version da P0.2. Replay antigo não designa/restaura responsável nem produz efeitos novos.

Instituições legadas exigem designação explícita de admin ativo existente; sem inferência/backfill. owner/coordinator não são convertidos em admin. Versão do responsável é independente da versão operacional.

Substituição exige Auth único/confirmado. Cria vínculo admin ou reativa admin existente; rejeita alvo já ligado como owner/coordinator/teacher/student. Transação ativa novo admin, troca ponteiro por CAS e inativa anterior apenas no tenant afetado, preservando papel, Auth, outros vínculos e histórico. Guard impede apagar, demover, inativar ou trocar identidade do responsável atual sem substituição. Concorrência retorna409; replay devolve snapshot original, sem efeitos. Consultar GET para estado vigente.

Mutações novas exigem tenant ativo; leitura global/histórico/reativação continuam possíveis durante suspensão. Envio Auth já iniciado pode terminar durante suspensão, sem criar vínculo/privilégio; reconciliação institucional continua bloqueada até reativação. Suspensão não bane identidade global ou seus outros tenants.

## Observabilidade e limites

Respostas conservam `{error:{code,message,requestId}}`, X-Request-Id e Cache-Control:no-store, private. Erros relevantes: INVALID_SESSION401, RECOVERY_INVALID_OR_EXPIRED401, AUTH_RECOVERY_NOT_CONFIGURED503, ACCOUNT_INVITE_NOT_CONFIGURED503, ACCOUNT_PROVISIONING_PENDING503, RESPONSIBLE_VERSION_CONFLICT409, ACCOUNT_AUTH_UNCONFIRMED409. SQL/stack/mensagens do provedor nunca são enviados. Logs registram somente método/rota normalizada/status/duração/requestId/categoria/código/tenant seguro; não corpo/email/token/cookie/prova/senha. Contexto global não ganha tenant por header. Ver [observabilidade](observability.md).

Limites por IP/processo: login30/15min preservado, refresh60/min, recovery10/15min, reset/ativação30/15min compartilhados, novas mutações administrativas30/min compartilhadas. Convites/P0.2 mantidos.429 inclui Retry-After; não é bloqueio persistido de conta. Múltiplas réplicas precisam limite de gateway/distribuído. Express não habilita trust proxy irrestrito; proxy pode agrupar clientes até configuração restrita separada. Não confiar em X-Forwarded-For arbitrário.

Auditoria transacional acrescenta account_provisioning_requested/account_invite_requested/account_invite_reconciled/responsible_designated/responsible_replaced sem dados pessoais. Intenções guardam nome/email privados para reconciliação; service_role lê somente colunas mínimas, sem DML direto. RPCs SECURITY DEFINER/search_path fixo exclusivas de service_role; allowlist validada na API, não em app_users. Service key continua segredo privilegiado do servidor.

## Migration e aplicação futura

Nova `20261101000007_accounts_and_responsibility.sql`, após00006 e cadeia anterior. SHA256 normalizado `54fd8b335797a339018c5f89f430777f7ba581c3d862d84e6fae3735ea1711db`. Adiciona intenções/journal, responsabilidade/guards, previous_user_id/ações na auditoria e RPCs. Encapsula bootstrap preservando helper histórico privado; não modifica SQL anterior nem apaga dados. Não altera Auth/SMTP nem cria tabela de senha/token.

Nada aplicado remotamente. Antes de implantação: concluir inventário10.2, confirmar alvo/ledger/checksums/customizações, qualificar backup/restore, ensaiar cadeia em ambiente isolado, obter autorização específica e coordenar DDL/API. Usar executor protegido `scripts/lib/migration-executor.cjs`; não SQL Editor/SQL bruto/CLI que contorne preflight de identidades legadas, nem setup/seed para upgrade. Manifesto agora11fontes, anteriores imutáveis. Ausência de estrutura nova retorna503 DATABASE_MIGRATION_REQUIRED onde identificável. Nenhuma migration no startup. Sem downgrade automático/destrutivo; planejar recuperação antes da aplicação real.

## Validação local reproduzível

Node22 e dependências locais; Docker para PostgreSQL16/PostgREST12.2.3. Definir DOTENV_CONFIG_PATH para caminho inexistente durante testes, jamais carregar credenciais reais. Runners exigem --allow-local-migrations, usam loopback/containers descartáveis próprios/dados sintéticos, bloqueiam fetch externo e limpam infraestrutura.

```text
node node_modules/jest/bin/jest.js --runInBand
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node scripts/academic-production-smoke.cjs
node scripts/accounts-database-test.cjs --allow-local-migrations
node scripts/accounts-http-test.cjs --allow-local-migrations
node scripts/platform-institutions-http-test.cjs --allow-local-migrations --p0-3-regression
node scripts/stage9-http-integration.cjs --allow-local-migrations
```

SQL real valida locks/constraints/rollback/ACL/concorrência. HTTP compilado usa Express/SDK/PostgREST/PostgreSQL reais e **Auth sintético local**. Não testa internos GoTrue, reutilização/expiração reais, SMTP/templates ou ambiente remoto. Recusa de reutilização na fixture é escolha do teste, não garantia real do Supabase. Fontes: [refreshSession](https://supabase.com/docs/reference/javascript/auth-refreshsession), [resetPasswordForEmail](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail), [sessões](https://supabase.com/docs/guides/auth/sessions), [inviteUserByEmail](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail). SDK instalado @supabase/auth-js2.106.2 inspecionado como contrato executável.
