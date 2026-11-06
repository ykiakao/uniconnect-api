# Chat privado Supabase Realtime — Implementation Plan

**Goal:** Preparar backend e SQL para chat HTTP persistido com Broadcast privado e janela institucional, sem aplicar SQL ou alterar serviços remotos.

**Architecture:** HTTP continua sendo a fonte de verdade. Triggers transacionais usam `realtime.send` em tópicos privados por tenant/conversa/destinatário Auth; somente participantes ativos recebem sinais sem conteúdo. JWT convencional autentica canais; o Flutter recupera conteúdo/cursor pelo HTTP.

**Tech Stack:** TypeScript/Express, Jest/Supertest, PostgreSQL e Supabase Realtime Broadcast. Nenhuma dependência nova.

## Tarefas

- [x] Escrever testes de limites de horário, contrato de assinatura e recusas de autorização; executar RED.
- [x] Expor horário e descritor autorizado na API e traduzir o erro do relógio SQL, mantendo os endpoints e o replay idempotente fora da janela.
- [x] Escrever testes estáticos de contrato SQL e preparar SQL versionado, sem executá-lo: ACL, RLS, emissão transacional e horário no instante da inserção.
- [x] Preparar testes SQL de autorização/horário para execução futura autorizada; não criar contas.
- [x] Documentar contrato Flutter: JWT, assinatura antes do catch-up, cursor contíguo, deduplicação, retries, refresh, troca de tenant e reconexão.
- [x] Rodar Jest pertinente, typecheck e build; solicitar revisão independente e corrigir findings; registrar evidências e pendências.

## Limites e decisões aprovadas

- Base `888744ecf4dc1f7b220ea9850c0f2bca0fa41c35`; branch local `codex/integration-chat-realtime`; sem commits/push.
- Segunda a sexta em America/Rio_Branco: 13:00 inclusivo, 18:00 exclusivo. Histórico/leitura disponíveis fora da janela.
- Nenhum SQL remoto/local dos scripts novos será executado nesta tarefa. Sem Docker, PG17, Portainer ou usuários reais novos.
- SQL em `supabase/scripts/chat-realtime-broadcast.sql`; não alterar as migrations históricas nem o manifesto do PG17.
- Canais por destinatário reduzem vazamento por cache de autorização: o trigger consulta participantes/tenant atuais antes de emitir para cada tópico.
- Realtime é sinal de atualização, não armazenamento nem transporte de comandos de envio. Reconciliação HTTP é obrigatória, inclusive na ausência de sinais.
- Provas SQL/RLS e duas sessões reais permanecem pendentes de autorização específica; testes offline não as substituem.

## Verificação final local — 05/11/2026

Jest dirigido a comunicação, autenticação, permissões e regressões de segurança: **260 testes, 14 suítes, todos aprovados**. TypeScript (`tsc --noEmit`), build (`tsc -p tsconfig.build.json`) e `git diff --check` aprovados. Comandos e limites em `docs/chat-realtime.md`.

Revisão independente em leitura concluiu sem novos findings impeditivos após as correções de replay fora da janela, tratamento do transporte best effort e alinhamento de `readerId`. Aprovação estritamente estática: nenhum SQL, probe Realtime, deploy ou teste com duas sessões foi executado.

## Handoff e preparação da publicação — atualização posterior em 05/11/2026

Os limites e resultados acima descrevem a implementação inicial. Em etapas posteriores, com autorizações específicas, o patch foi aplicado uma única vez ao projeto de teste, a API local iniciou com Node 22.23.4/porta 3334, as duas contas existentes autenticaram, uma conversa foi criada e os descritores/históricos foram consultados. Dois canais privados chegaram a SUBSCRIBED e o tópico de outro destinatário foi recusado. O primeiro MissingPartition foi diagnosticado em leitura; as partições automáticas já existiam e o reteste passou. Não houve mensagem ou recibo real. A janela estava fechada, com `canSendNow: false`. Não reaplicar o patch, repetir seeds ou criar fixtures adicionais para o handoff.

### Manifesto de publicação proposto

Base: `888744ecf4dc1f7b220ea9850c0f2bca0fa41c35`; destino: a própria branch `codex/integration-chat-realtime` no repositório da API. Esta é a branch de contrato/backend para consumo pelo desenvolvedor Flutter, não uma branch de código Dart.

Commit 1 proposto: `feat(chat): add private Realtime Broadcast integration` — 12 arquivos:

- `src/modules/communication/communication.repository.ts`
- `src/modules/communication/communication.routes.ts`
- `src/modules/communication/communication.schemas.ts`
- `src/modules/communication/communication.service.ts`
- `src/modules/communication/chat-realtime.ts`
- `src/modules/communication/communication.test.ts`
- `src/modules/communication/chat-realtime.test.ts`
- `src/modules/communication/chat-realtime-sql.test.ts`
- `src/test/communication-mock.ts`
- `supabase/scripts/chat-realtime-broadcast.sql`
- `supabase/tests/chat-realtime-authorization.sql`
- `supabase/tests/chat-realtime-transaction.sql`

Commit 2 proposto: `docs(chat): document Flutter handoff and controlled rehearsal` — 2 arquivos:

- `docs/chat-realtime.md`
- `docs/codex-kit/plans/2026-11-05-chat-realtime.md`

Não incluir perfis `.env*` privados, senhas, sessões/JWTs, logs, HAR, evidências privadas, dependências, build ou scripts ad hoc do ensaio. Os três SQLs acima são artefatos revisáveis do produto/testes, não resultados privados: o patch é de aplicação única e os probes recebem fixtures por parâmetro, sem credenciais. `docs/codex-kit/plans` contém este plano versionável; é distinto do kit local `.codex-kit`, ignorado pelo Git.

Sequência proposta, a executar somente após autorização para os dois commits e o push:

1. Reconfirmar branch, HEAD, os 14 caminhos e índice; interromper se houver alteração concorrente ou arquivo adicional. Usar `git add -- <lista explícita dos 12 caminhos do commit 1>`, sem `git add .`.
2. Conferir `git diff --cached --name-only` e `git diff --cached --check`; criar o commit 1 com a mensagem acima.
3. Adicionar explicitamente somente os dois documentos; conferir o diff e criar o commit 2.
4. Conferir os dois commits completos, a ausência de segredos e o destino remoto; então `git push -u origin codex/integration-chat-realtime`. Sem merge, alteração de main ou deploy. Se a branch remota tiver divergido, interromper; não usar force push.

Comandos propostos para a seleção exata, executados por blocos e somente após autorização:

```powershell
$chatRuntimeFiles = @(
  'src/modules/communication/communication.repository.ts'
  'src/modules/communication/communication.routes.ts'
  'src/modules/communication/communication.schemas.ts'
  'src/modules/communication/communication.service.ts'
  'src/modules/communication/chat-realtime.ts'
  'src/modules/communication/communication.test.ts'
  'src/modules/communication/chat-realtime.test.ts'
  'src/modules/communication/chat-realtime-sql.test.ts'
  'src/test/communication-mock.ts'
  'supabase/scripts/chat-realtime-broadcast.sql'
  'supabase/tests/chat-realtime-authorization.sql'
  'supabase/tests/chat-realtime-transaction.sql'
)
git add -- $chatRuntimeFiles
git diff --cached --name-only
git diff --cached --check
```

Depois de conferir que o índice contém exatamente esses 12 arquivos:

```powershell
git commit -m 'feat(chat): add private Realtime Broadcast integration'
git add -- docs/chat-realtime.md docs/codex-kit/plans/2026-11-05-chat-realtime.md
git diff --cached --name-only
git diff --cached --check
```

Depois de conferir os dois documentos e a autorização de publicação:

```powershell
git commit -m 'docs(chat): document Flutter handoff and controlled rehearsal'
git log -2 --stat
git push -u origin codex/integration-chat-realtime
```

Checks locais desta preparação: 260/260 testes em 14 suítes novamente aprovados com Node 22.23.4; `tsc --noEmit` e `git diff --check` aprovados. Gitleaks analisou o conteúdo dos 14 candidatos com redação integral de achados e não encontrou segredos. Nenhum candidato privado/gerado foi encontrado. Revisão independente em leitura do manifesto, contrato e proposta de exceção concluiu sem finding impeditivo. Nada foi adicionado ao índice ou commitado nesta preparação.

### Proposta de ensaio excepcional — NÃO implementada nem autorizada para execução

O caminho preferencial sem mudança de banco continua sendo o ensaio na janela normal. Para a exceção solicitada, a menor superfície técnica é uma substituição temporária e estritamente delimitada do corpo de `public.chat_enforce_service_window()` **somente em uniconnect-test**. Não criar um flag permanente no backend ou uma migration de produção. O patch aprovado, seu hash e os arquivos TypeScript permanecem intactos.

**Controles atuais:** Express calcula `serviceWindow.canSendNow` no descritor por `chatServiceOpen()`; esse campo é informativo. O envio HTTP não contém um segundo bloqueio de horário: o repositório chama `academic_chat_send` e traduz `PCH01` para `403 CHAT_OUTSIDE_SERVICE_HOURS`. O bloqueio autoritativo é o trigger `zz_chat_service_window`, antes do INSERT, que chama `chat_enforce_service_window()` e consulta `chat_service_open(clock_timestamp())`. Histórico/recibos e replay idempotente sem INSERT já têm seu comportamento normal fora da janela.

**Escopo obrigatório da exceção futura:** manter a regra normal e permitir a exceção somente quando TODAS as condições adicionais forem verdadeiras: conexão comprovada com `pvacwfypqsstdrfxajkg`; horário real do banco dentro de um intervalo UTC absoluto de no máximo 15 minutos; tenant, conversa e turma iguais às fixtures existentes aprovadas; `NEW.sender_id` em uma allowlist dos dois IDs institucionais; a conversa continua contendo exatamente esse aluno/professor e seus vínculos Auth esperados, ativos, no tenant operacional. Os valores exatos devem vir do registro privado já existente do ensaio, não de um header, corpo HTTP, variável do Flutter ou UUID novo. A checagem de vínculo da RPC existente continua obrigatória. Não usar `auth.uid()` como se identificasse o aluno nesse trigger: a RPC HTTP utiliza a credencial service_role e recebe o ator institucional já autorizado pela API.

**Ativação futura, após aprovação explícita:**

1. Conceder autorização separada para preparar/revisar o SQL de instalação e reversão e, depois, para executá-lo no projeto de teste. Esta seção é apenas desenho operacional, sem bypass executável.
2. Reconfirmar o projeto no executor pelo endpoint/conexão de teste e pelas fixtures existentes. Capturar em evidência privada a definição efetiva original, SHA-256 normalizado, owner/ACL/configuração da função e identidade/estado do trigger. Se divergir do baseline aprovado, parar; não sobrescrever mudanças concorrentes.
3. Preparar e revisar instalação/reversão como artefatos privados exclusivos de homologação, fora da branch publicável. O instalador deve recusar qualquer destino que não seja o projeto de teste e conferir o baseline antes de substituir o corpo da função; nada altera `chat_service_open`, o trigger, grants, policies, RPC histórica, relógio ou os emissores Broadcast. Substituir a função em transação curta com interrupção no primeiro erro e lock timeout; não manter transação aberta durante o ensaio. Conferir owner/ACL e trigger após commit.
4. Validar a recusa de identidades, tenant, turma, conversa e tempos fora da allowlist em testes locais pertinentes antes da ativação. Executar apenas a sequência de mensagens/recibos especificamente autorizada, pela API HTTP existente, com as sessões válidas. Parar ao primeiro resultado inesperado ou fim do prazo; nenhuma escrita de teste é autorizada por este documento.

**Descritor durante a exceção:** `canSendNow` continua refletindo a agenda normal e permanecerá `false` fora dela. A autorização anterior exigia `true`; o ensaio excepcional requer nova aprovação que substitua expressamente essa condição apenas para as fixtures/prazo aprovados. Usar um executor de ensaio dedicado; não fazer o Flutter ignorar o campo nem apresentar `true` artificialmente. Se for requisito que o descritor reconheça a exceção, essa é uma alteração adicional a desenhar/aprovar antes, fora desta proposta mínima.

**Reversão e aceite:** ao terminar, falhar ou expirar o prazo, restaurar transacionalmente a definição original exata da função, a partir do snapshot aprovado; verificar que o hash atual ainda é o da instalação temporária antes de substituir, para não apagar mudanças de terceiros. Conferir definição/owner/ACL e trigger após o commit. O prazo absoluto impede novas inserções excepcionais mesmo se a reversão manual atrasar; não substitui a restauração estrutural. Preservar mensagens e recibos sintéticos como evidência; não apagar conversa, dados ou políticas preexistentes. Uma tentativa com UUID novo fora do horário, se autorizada como teste negativo, deve voltar a receber `403 CHAT_OUTSIDE_SERVICE_HOURS`; replay de mensagem já persistida continua permitido e não serve como teste de bloqueio. Se a recuperação falhar, não fazer novos envios e informar o estado efetivo; nunca desabilitar o trigger para contornar o erro.

**Riscos e decisão:** a exceção permite escritas reais e eventos na única conversa autorizada; provas de entrega/deduplicação/recibos ainda precisam ser produzidas. Existe risco de corrida com alteração da mesma função e breve contenção de lock no DDL, mitigados por hash prévio, prazo curto, lock timeout e reversão revisada. Expiração deve usar relógio real do banco, sem extensão automática. A exceção não constitui teste de produção nem aprovação de sua promoção. Apenas esta proposta textual é versionável; SQL temporário, dados privados e qualquer flag de bypass ficam fora dos commits propostos.

Na futura substituição, reproduzir explicitamente os atributos originais da função, incluindo SECURITY DEFINER, search_path vazio e volatilidade; o snapshot deve permitir verificar os demais atributos. CREATE OR REPLACE preserva owner e permissões, mas os outros atributos assumem os valores explícitos ou implícitos do novo comando. Referências oficiais: [CREATE FUNCTION](https://www.postgresql.org/docs/17/sql-createfunction.html) e [clock_timestamp](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
