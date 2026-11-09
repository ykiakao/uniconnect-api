# Comunicação acadêmica — Etapa 8

Backend HTTP persistente para avisos, conversas aluno/professor, mensagens, recibos e notificações internas. Somente `uniconnect-api`; nenhuma mudança de Flutter/painel, credencial, portal ou Supabase remoto. Não há entrega de push, email ou WebSocket nesta etapa.

O estado descrito é do código preparado e testado localmente. A aplicação manual autorizada das migrations no ambiente de destino é um pré-requisito; a API não as aplica no startup. Resultados e inventário em stage-8-report.md.

## Decisões e compatibilidade

A auditoria encontrou `public.messages` com tenant, remetente institucional, turma opcional, conteúdo e horário, mas sem destinatário/conversa ou endpoints. A tabela foi reutilizada: `conversation_id`, `client_message_id` e `sequence` identificam mensagens novas. Registros antigos permanecem sem esses campos, intactos e fora da nova API. Não é possível deduzir seus participantes com segurança. Não se criaram outra tabela de mensagens, matrículas ou associações fictícias.

Atividades, notas, entregas, providers Demo e Native continuam com seus contratos anteriores. Notificações são acrescentadas pelos eventos persistidos, independentemente do provider selecionado. O provider demo de consulta não passa a gerar atividades/notas fictícias persistidas. Não existe sincronização ou chamada a portal.

Os consumidores futuros são Flutter para consulta/comunicação pessoal e painel web para administração institucional. As regras residem em serviços/repositories e funções transacionais, sem dependência de Request/Response no serviço. Os contratos foram registrados no plano antes das mudanças estruturais.

## Modelo e integridade

| Entidade | Responsabilidade |
| --- | --- |
| `academic_notices` | Autor institucional, título/conteúdo, público institution/course/class, alvo do tenant, prioridade, estado, revisão, publicação, expiração e horários. |
| `academic_notice_revisions` | Histórico append-only de conteúdo/estado, autor efetivo da alteração e horário. |
| `academic_notice_recipients` | Snapshot do público na publicação e última revisão lida por cada destinatário. |
| `academic_notice_reads` | Recibos append-only por destinatário/revisão; preserva leituras anteriores após edição. |
| `academic_conversations` | Tupla única tenant/oferta/aluno/professor, última sequência e horários. |
| `messages` existente | Mensagens novas append-only, sequência da conversa e chave idempotente do remetente. Legado preservado. |
| `academic_conversation_reads` | Watermark monotônico de leitura por participante. |
| `academic_notifications` | Destinatário institucional, evento, chave única, referência FK, criação e leitura; sem corpo de mensagem/nota/feedback. |

Identidades pessoais nas novas entidades são `app_users.id`, e não IDs escolhidos livremente pelo cliente. As referências compostas validam tenant/usuário/curso/oferta/matrícula/docência/conversa. Notificações de resultados referenciam também a revisão da nota para manter a origem auditável. Índices atendem consultas por destinatário, não lidas, oferta, sequência e prazo.

Históricos, novas mensagens, identidades de conversas e snapshots não podem ser apagados/alterados silenciosamente. Exclusões em cascata das entidades antigas não podem remover o novo histórico. A FK de tenant/remetente em `messages` é `NOT VALID` para não rejeitar possíveis inconsistências legadas durante a migration; novas linhas e alterações continuam sujeitas à constraint. A validação global do legado requer inventário autorizado no destino. A API não usa registros antigos sem conversa.

As tabelas novas têm RLS e ficam privadas. Apenas as RPCs necessárias são executáveis por `service_role`, com `SECURITY DEFINER` e `search_path` fixo; helpers não são uma interface pública. O trigger de eventos também usa `SECURITY DEFINER`, com execução privada, para preservar o lançamento legado de notas realizado diretamente pelo servidor. Isso foi comprovado com `SET ROLE service_role` no PostgreSQL local. Nenhum acesso público a mensagens ou notificações foi criado.

## Autenticação e autorização

Todos os caminhos usam o prefixo `/api/v1/tenants/:slug`, `Authorization: Bearer <token UniConnect>` e o contexto institucional existente (`x-tenant-slug`). Slug/header/sessão precisam ser coerentes. O middleware relê o vínculo e bloqueia membros desativados; as funções SQL revalidam autorizações de escrita após locks.

| Ação | Autorização |
| --- | --- |
| Aviso institucional ou por curso | Owner/admin/coordenador do próprio tenant. |
| Aviso de oferta | Gestor institucional ou professor com atribuição ativa nessa oferta. |
| Consultar aviso destinado ao usuário | Destinatário do snapshot, enquanto membro institucional ativo; nunca draft. |
| Gerenciar/revisar avisos | Gestor ou professor atualmente autorizado à oferta; aluno não publica nem vê histórico de rascunhos. |
| Iniciar conversa/enviar mensagem | Par aluno/professor, ambos ativos, matrícula active e docência active, oferta/disciplina/período ativos. |
| Consultar conversa/histórico | Somente seus dois participantes institucionais ativos. Papel de gestor não permite ler conversas de terceiros. |
| Consultar/marcar notificações | Somente o próprio destinatário institucional ativo. |

Conhecer um UUID não concede acesso. Recursos de outro tenant/participante retornam404; papel ou vínculo atual insuficiente em mutação retorna403. Oferta/disciplina/período inativos são conflito de estado409. O cliente não pode especificar remetente, autor ou horário. Não há canais globais nem autorização administrativa global derivada de papel institucional.

## Avisos: público, estados, histórico e leitura

Público materializado **na publicação**, em uma transação com o aviso e suas notificações:

- `institution`: membros ativos do tenant.
- `course`: alunos com matrícula active e docentes com atribuição active em ofertas do curso. Nome textual e `app_users.course_id` isolado não autorizam recebimento.
- `class`: alunos com matrícula active e docentes com atribuição active na oferta.

Não há seleção livre de conjunto de usuários, porque não foi identificada necessidade que justifique essa superfície adicional. O limite é10000 destinatários por fanout; exceder retorna409 e reverte a publicação inteira, sem truncamento silencioso. Os recipients do aviso incluem professores elegíveis; notificações de atividade e lembrete são direcionadas aos alunos.

O snapshot fornece histórico estável: quem recebeu mantém acesso após matrícula completed/cancelled/suspended ou mudança posterior do vínculo docente, enquanto seu vínculo institucional permanecer ativo. Quem se matricula depois não ganha acesso retroativo ao snapshot. O gerenciamento depende de autorização atual, separadamente do acesso histórico como destinatário. Desativação institucional bloqueia ambos. Uma edição nunca troca o público nem adiciona destinatários silenciosamente.

Estados: `draft → published → archived`. Não há retorno a draft, exclusão ou alteração de aviso arquivado. Público e autor são imutáveis; mesmo a edição de draft conserva o alvo inicial. Para outro alvo, criar outro draft. Publicar aviso de oferta exige oferta/disciplina/período ativos. A expiração é reavaliada após os locks dos destinatários; aviso já expirado não é publicado. Não existe arquivamento automático.

Edição de conteúdo/título/prioridade/expiração de aviso publicado usa `expectedRevision`, incrementa revisão e mantém histórico. A publicação inicial gera uma notificação por destinatário; edições posteriores não repetem essa notificação. Read compara a revisão vista com a atual: revisão desatualizada409. Repetir a confirmação da mesma revisão retorna o mesmo horário; leituras de revisões anteriores permanecem em `academic_notice_reads`. A leitura de um usuário não modifica os demais.

Listagem padrão `view=active`: somente avisos recebidos, publicados e ainda não expirados. `view=history`: publicados, expirados e arquivados recebidos. `view=managed`: escopo de gerenciamento, incluindo drafts. Gestor/professor pode consultar um aviso que gerencia mesmo sem pertencer ao snapshot. O histórico de revisões é restrito ao gerenciamento, evitando expor antigos conteúdos de rascunho a destinatários.

## Conversas, mensagens e leitura

Cada oferta/aluno/professor tem uma conversa por tenant. Criar a mesma tupla em qualquer direção retorna a mesma conversa; pares sem vínculo são recusados. Após matrícula ou atribuição encerrarem, participantes ativos mantêm histórico, mas não enviam mensagens novas. É possível consultar histórico quando o outro participante está inativo; enviar para esse participante é bloqueado. Nenhum usuário inativo acessa sua própria conversa.

Envio exige `clientMessageId` UUID, persistido antes de o cliente descartar sua tentativa. Repetir o mesmo ID/conteúdo na mesma conversa/remetente retorna a mesma mensagem, sem nova sequência ou notificação. Mesmo ID com conteúdo diferente retorna409. A verificação de vínculo atual ocorre antes do retry: se a autorização foi revogada, a repetição de envio também é recusada; o histórico autorizado permite reconciliar o resultado anterior. IDs diferentes representam mensagens distintas, mesmo com texto igual.

`sequence` cresce por conversa sob lock. Novas mensagens usam `clock_timestamp()` após os locks, registrando o instante efetivo de envio, sem herdar o horário de início da transação. O histórico é ascendente por sequência, com `afterSequence` exclusivo e limite1–100; não depende de horários únicos. A resposta contém `hasMore` e `nextAfterSequence`; página vazia mantém o cursor recebido. Guardar esse cursor para recuperar lacunas, sem deduplicar somente por texto. A lista de conversas usa criação decrescente e ID para desempate; `updatedAt` informa o último envio, mas não altera a ordenação da lista.

Read usa `upToSequence`: somente watermark do usuário autenticado, nunca além da última mensagem. Confirmar novamente ou enviar valor menor não reduz o watermark nem troca o horário já registrado. `readByRecipient` na consulta de mensagens resulta do watermark do outro participante. Não há edição/exclusão de mensagem pelo HTTP.

## Endpoints e exemplos

Prefixo de todos: `/api/v1/tenants/:slug`. IDs novos são UUID. Corpos estritos, título1–200, conteúdo1–10000 caracteres após validação/trim, prioridade `low|medium|high` (padrão medium), datas ISO8601 com offset válido, normalizadas para UTC. Campos de texto não são HTML confiável: consumidores devem renderizá-los como texto, sem HTML bruto. Corpo JSON continua sujeito ao limite100kb existente.

| Método | Caminho | Entrada/retorno |
| --- | --- | --- |
| POST | `/notices` | Título, conteúdo, audienceType, alvo opcional, prioridade/expiração;201 draft. |
| GET | `/notices` | view/page/limit; `{data,meta}`. |
| GET | `/notices/:id` | Detalhe autorizado e recibo pessoal. |
| PUT | `/notices/:id` | Campos editáveis e expectedRevision. |
| POST | `/notices/:id/publish` | `{expectedRevision}`; publicação e notificações atômicas. |
| POST | `/notices/:id/archive` | `{expectedRevision}`; somente publicado. |
| POST | `/notices/:id/read` | `{expectedRevision}`; recibo próprio. |
| GET | `/notices/:id/history` | page/limit; revisões para gerenciamento. |
| POST | `/conversations` | `{classId,participantId}`;201 conversa idempotente. |
| GET | `/conversations` | page/limit; somente próprias. |
| GET | `/conversations/:id` | Detalhe autorizado. |
| POST | `/conversations/:id/messages` | `{content,clientMessageId}`;201 mensagem idempotente. |
| GET | `/conversations/:id/messages` | afterSequence/limit; histórico e cursor. |
| POST | `/conversations/:id/read` | `{upToSequence}`; watermark próprio. |
| GET | `/notifications` | page/limit/unreadOnly=true ou false; somente próprias. |
| GET | `/notifications/unread-count` | `{unreadCount}`. |
| POST | `/notifications/:id/read` | `{}`; marcação própria idempotente. |

page1–100000, limite1–100 (padrão20). Listas comuns têm `meta:{page,limit,total}`. Consultas filtram autorização antes da paginação/contagem; não aceitam `recipientId` ou outro seletor de usuário. Mutações têm60 requisições/minuto/IP por rota, preservando os limites anteriores. Rate limiting em memória é por processo; múltiplas instâncias precisam de estratégia compartilhada.

Exemplo de criação sintética por professor autorizado:

```json
{
  "title": "Orientações do projeto",
  "content": "Consulte as instruções da atividade antes do prazo.",
  "audienceType": "class",
  "classId": "20000000-0000-4000-8000-000000000003",
  "priority": "high",
  "expiresAt": "2026-11-10T23:59:00-05:00"
}
```

Para `institution`, omitir courseId/classId; para `course`, enviar somente courseId. Resposta inclui `id,authorId,title,content,audienceType,courseId,classId,state,priority,revision,expiresAt,publishedAt,createdAt,updatedAt,readAt,readRevision`. `readAt:null,readRevision:0` representam ausência de confirmação, sem data inventada. Criação tem revisão1; publicação normalmente produz revisão2. A confirmação retorna `{noticeId,readRevision,readAt}`. Revisões retornam `noticeId,revision,title,content,state,changedBy,changedAt`, com ordenação decrescente.

Criar conversa: `{ "classId":"20000000-0000-4000-8000-000000000003", "participantId":"20000000-0000-4000-8000-000000000002" }`. ParticipantId é a contraparte e é validado contra a oferta; não permite escolher qualquer usuário. Retorno: `id,classId,studentId,teacherId,lastSequence,createdAt,updatedAt`.

Enviar mensagem: `{ "content":"Mensagem sintética", "clientMessageId":"20000000-0000-4000-8000-000000000100" }`. Retorno: `id,conversationId,senderId,content,sequence,clientMessageId,createdAt,readByRecipient`. Na resposta imediata de envio, o indicador de leitura é falso; consultar o histórico para o estado atualizado. `GET .../messages?afterSequence=0&limit=20` retorna:

```json
{
  "data": [],
  "meta": { "limit": 20, "afterSequence": 0, "hasMore": false, "nextAfterSequence": 0 }
}
```

Marcar leitura: `{ "upToSequence":3 }` → `{conversationId,lastReadSequence,readAt}`. Toda data de escrita/leitura é gerada no banco. Não registrar esse conteúdo em logs do consumidor.

## Notificações e consistência

| Evento | Origem e destinatário |
| --- | --- |
| `notice_published` | Primeira publicação; snapshot dos destinatários ativos. |
| `activity_published` | Publicação real de atividade; alunos ativos com matrícula active. |
| `activity_result_published` | Revisão publicada de grades; somente o aluno ativo correspondente. Rascunho não notifica; revisão publicada posterior é um novo evento legítimo. |
| `message_received` | Mensagem nova; somente outro participante ativo, nunca o remetente. |
| `activity_due_soon` | Rotina explícita; aluno ativo/matrícula active, atividade publicada e prazo próximo, sem entrega nem nota existente. |

Resultados históricos mantêm as regras de autorização da Etapa7; notificação não concede novo acesso ao recurso. Destinatário inativo não recebe notificação como ativo. Não há geração retrospectiva para notas/atividades já existentes quando a migration é aplicada. Depois de reativado, o usuário vê seu histórico persistido, mas não recebe automaticamente eventos que ocorreram durante a inatividade.

Triggers gravam notificações **na mesma transação** de publicação/resultado/mensagem. Falha em gravá-las reverte o evento de origem; não se promete entrega best-effort como garantida. A unicidade de evento/destinatário evita duplicação. A chave de resultado usa a revisão publicada; a de mensagem usa a mensagem persistida; a de lembrete usa atividade/prazo exato, independente do timezone da sessão. Alterar/estender prazo permite lembrete distinto; repetir o mesmo prazo não duplica. Publicação repetida de aviso/atividade pode retornar409 por CAS/estado, sem gerar outra notificação.

O formato público não contém texto de mensagem, nota ou feedback:

```json
{
  "id": "20000000-0000-4000-8000-000000000101",
  "type": "message_received",
  "resourceType": "message",
  "resourceId": "20000000-0000-4000-8000-000000000102",
  "createdAt": "2026-10-26T15:00:00.000Z",
  "readAt": null
}
```

resourceType é notice/activity/grade/message. As referências são identificadores persistidos, não URLs arbitrárias; o cliente precisa buscar o recurso por uma rota autorizada e respeitar403/404 após mudança de vínculo. Não há endpoint novo de detalhe de nota por gradeId: resultados continuam nas consultas pessoais/overview existentes, e mensagens são consultadas pelo histórico da conversa. A resolução de navegação a partir de referências sem rota de detalhe é uma decisão de integração futura; não se deve construir caminhos livres a partir de IDs de notificações.

Marcar notificação como lida não confirma automaticamente leitura do aviso ou das mensagens; são recibos distintos. Contagem de não lidas é própria, não global. Notificações históricas permanecem mesmo que o recurso deixe de estar ativo.

## Rotina de prazos próximos

Nenhum scheduler é iniciado pela API. Após build e aplicação autorizada das migrations no ambiente escolhido, um operador/agendador externo pode executar explicitamente com a configuração Supabase existente do servidor:

```powershell
node scripts/notify-upcoming-deadlines.cjs --help
node scripts/notify-upcoming-deadlines.cjs --tenant-id <UUID-do-tenant> --window-minutes 1440 --limit 100
```

`--tenant-id` obrigatório; janela1–10080 minutos; limite1–100 atividades, padrão100; `--after-id UUID` continua a página anterior. Flags desconhecidas/duplicadas são recusadas. Cada invocação faz **uma página**, retorna JSON `{processedActivities,createdNotifications,hasMore,nextAfterId}` e termina. Com hasMore=true, o agendador precisa repetir com nextAfterId. Cada nova varredura periódica começa sem cursor. Não se oferece parâmetro de URL ou credencial na linha de comando.

A rotina chama somente a RPC privada `generate_academic_deadline_notifications`; não existe endpoint HTTP para dispará-la. Filtra estado/oferta/período/disciplina, matrícula, membro, submissão e grade, reavaliando prazo após espera. Repetição/concorrência é idempotente. A ausência de scheduler significa que lembretes não serão criados automaticamente até que uma execução externa seja configurada. Monitorar exit code e cursor; uma chamada que falha não é apresentada como sucesso. A CLI foi testada com dados/SDK sintéticos e `--help`; não foi executada contra Supabase remoto.

## Preparação para tempo real

Não há servidor WebSocket ou broadcast implementado. A dependency `ws` já existia para o SDK e não comprova infraestrutura de autenticação/revogação para chat. O transporte HTTP permanece plenamente funcional. Os contratos internos em `communication.schemas.ts` definem eventos sem texto privado:

```text
message.created: tenantId, conversationId, messageId, sequence
conversation.read: tenantId, conversationId, userId, upToSequence
notification.created: tenantId, userId, notificationId
```

Na evolução: autenticar handshake com a sessão UniConnect, resolver tenant/identidade no servidor, autorizar assinatura por participação atual e revalidar em cada envio/assinatura/reconexão. Nunca aceitar sala global, userId livre ou tenant escolhido no payload. Revogação precisa encerrar assinaturas. Publicar sinal somente depois do commit; usar o estado persistido/cursor para recuperar eventos perdidos, sem alegar que um processo em memória fornece entrega garantida. Multi-instância e fanout realtime exigirão estratégia própria; nenhuma dependência complexa foi adicionada agora.

Na reconexão, consultar mensagens com o último afterSequence, consumir hasMore até recuperar a lacuna e reconciliar envios por clientMessageId. Avisos/notificações possuem listagem paginada; consumidores devem atualizar a lista/contagem após reconexão. Paginação por offset de listas mutáveis não é um snapshot único e pode requerer atualização/deduplicação por ID.

## Erros, logs e segurança operacional

Mantido `{error:{code,message,requestId}}`, `X-Request-Id`, `Cache-Control:no-store, private` e ausência de ETag. Logs usam template de rota, método, status, duração, tenant seguro e categoria/código; nunca conteúdo de mensagens/avisos, corpos completos, cookies ou tokens. Testes verificam ausência de conteúdo e IDs dinâmicos. Ver [observability.md](observability.md).

400 para JSON/UUID/datas/payload/query inválidos;401 sessão;403 autorização;404 recurso fora do escopo/inexistente;409 CAS/duplicidade divergente/estado/fanout;429 rate limit;502 resposta de dependência inválida;503 indisponibilidade ou RPC/schema ausente;500 falha inesperada sanitizada. Offsets de timezone inválidos são validação400, não erro interno. Falhas de consulta não viram listas vazias de sucesso. Respostas RPC são validadas antes de mapear DTOs, inclusive tenant, participante/destinatário e ordem/cursor de mensagens.

O fanout mantém locks SHARE de membros do tenant para estabilidade durante publicação. O custo cresce com a instituição; o limite10000 é de destinatários, não de linhas examinadas. Antes de grande escala, medir contenção e avaliar seleção/locks restritos ao público ou processamento por outbox com garantias equivalentes. Não se alega suporte ilimitado. História de texto requer política institucional de retenção/backup e autorização de acesso operacional; não apagar registros como rollback de aplicação.

## Migration e validação

Nova: `20261026000005_academic_communication.sql`, incremental/transacional, após bases e00001 segurança →00002 estrutura →00003 gestão →00004 atividades. Adiciona7 tabelas, campos/constraints em messages, índices, triggers e RPCs privadas, sem reescrever migrations anteriores. Nenhuma foi aplicada remotamente nesta etapa.

Testes PostgreSQL criam container16 efêmero, porta vinculada somente127.0.0.1 e senha aleatória. Não usam configuração remota nem dados reais. Limpeza atinge somente o container criado. Flag explícita obrigatória:

```powershell
node scripts/communication-database-test.cjs --allow-local-migrations
node scripts/activity-workflow-database-test.cjs --allow-local-migrations --with-communication
```

Gate local:408 testes/29 suítes; typecheck/build/smoke aprovados. Runner comunicação203 verificações reais; runner anterior235 verificações **com00005 instalada**, sem retirar testes. Incluem FK/RLS/privilégios, idempotência/concorrência, rollback de evento/notificação nas quatro origens imediatas, deadlines, desativação/revogação/expiração e horário efetivo durante locks, limite10000/10001 e ausência de backfill. A segurança do banco não foi inferida dos mocks. Resultados locais com Auth sintético não comprovam o estado remoto, os dados legados reais ou um deploy.
