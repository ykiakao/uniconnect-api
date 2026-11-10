# Provider acadêmico nativo — Etapa 6

Atualização da Etapa7: o provider agora usa a mesma visibilidade de atividades do aluno aplicada antes da paginação, oculta avaliações não publicadas e acrescenta campos opcionais `publicationState`, `instructions`, `evaluationCriteria`, `priority` e `allowLate`. Atividade encerrada corresponde a `status:closed`; publicação não prova entrega, portanto os demais status não são inferidos. Os detalhes do fluxo e da dependência adicional da migration00004 estão em [activity-workflow.md](activity-workflow.md). Os resultados e limites da Etapa6 abaixo são seu registro histórico; o gate atual está no relatório da Etapa7.

`NativeAcademicProvider` lê os registros institucionais persistidos do UniConnect pelos repositories existentes. Usa os mesmos endpoints e os registros persistidos do UniConnect.

## Configuração

Com Node.js22, após revisão, validação e aplicação manual autorizada das migrations pendentes, iniciar uma API com a configuração Supabase existente:

```powershell
$env:ACADEMIC_PROVIDER = 'native'
npm run build
npm start
```

Para a apresentação com dados fictícios, usar `ACADEMIC_PROVIDER=demo` e `ACADEMIC_DEMO_TENANT_SLUG=edukmais`. `disabled` continua sendo o padrão seguro. Essas opções pertencem ao servidor; não há parâmetro de cliente para escolher provider ou usuário. Native funciona em cada tenant autenticado, sem depender do slug da demo.

Nenhuma migration foi aplicada remotamente. A versão atual consulta `app_users.active` inclusive na autenticação; portanto um banco antigo precisa ser atualizado antes de utilizar esta versão, mesmo em modo demo. A demonstração continua dependendo da autenticação UniConnect/Supabase, mas seus dados acadêmicos não dependem de portal.

## Endpoints e permissões

| Método/caminho | Resposta nativa |
| --- | --- |
| GET `/api/v1/tenants/:slug/academic/periods` | Catálogo de períodos persistidos da instituição; visível a membros ativos, como no catálogo administrativo da Etapa4. |
| GET `/api/v1/tenants/:slug/academic/overview` | Período ativo entre os disponíveis; na ausência dele, maior código disponível. `?periodId=<id retornado>` seleciona um período persistido. |
| GET `/api/v1/tenants/:slug/academic/history` | Overviews dos períodos disponíveis, incluindo matrículas concluídas, canceladas e trancadas. |

Bearer, `x-tenant-slug` e slug da rota precisam representar o mesmo contexto. O usuário vem da sessão e seu vínculo institucional é relido; não há consulta arbitrária de outro aluno. Todas as respostas mantêm `no-store, private`, sem ETag, logs por template e correlação `X-Request-Id`/`error.requestId`.

Aluno recebe somente suas matrículas formais, incluindo histórico de todos os status. Professor recebe somente ofertas com atribuição docente ativa e suas atividades; não recebe avaliações individuais de alunos. Gestores mantêm os endpoints administrativos; overview/history são consultas pessoais e retornam403 para papéis sem perfil de aluno/professor. Não se utiliza o nome textual do curso como autorização.

Sem matrículas, overview de um período válido retorna `subjects: []`. Sem períodos persistidos, periods retorna lista vazia e overview retorna404 `ACADEMIC_PERIOD_NOT_FOUND`; não se fabrica um período. Identificadores de período inexistentes ou de outro tenant retornam404.

## Contratos e semântica

Os contratos genéricos da Etapa2 permanecem. Acréscimos opcionais: `subjects[].assessments` e `activities[].title`. Exemplo ilustrativo de uma disciplina nativa:

```json
{
  "id": "id-disciplina",
  "offeringId": "id-turma",
  "classId": "id-turma",
  "periodId": "id-periodo",
  "enrollmentSubjectId": "id-matricula-institucional",
  "name": "Disciplina sintética",
  "status": "in_progress",
  "grades": null,
  "attendance": { "absences": null, "absencePercentage": null },
  "assessments": [
    { "activityId": "id-atividade", "title": "Avaliação sintética", "grade": 0, "feedback": "Feedback sintético", "gradedAt": "2026-10-26T00:00:00Z" },
    { "activityId": "id-outra-atividade", "title": "Ainda sem nota", "grade": null, "feedback": null, "gradedAt": null }
  ]
}
```

`assessments` corresponde às atividades retornadas e às notas persistidas do próprio aluno. Não transforma uma nota em `assessment1`, `average`, `exam` ou `finalAverage`. Zero permanece zero; nota ausente/nula permanece null. Feedback e data de correção são preservados quando disponíveis. IDs legados de Auth utilizados internamente pelas notas não se tornam um seletor público de perfil.

Matrícula active corresponde a `in_progress`; completed a `completed`, sem deduzir aprovação. Cancelled e suspended preservam a situação da matrícula. No perfil docente, status acadêmico pessoal é `unknown`. O status da atividade também permanece `unknown` quando não existe estado persistido compatível; prazo não prova entrega ou aprovação.

Não há registros de frequência nem regras institucionais de médias nesta entrega: frequência e agregados permanecem null. Quando há disciplinas, a resposta declara `complete:false` com `ATTENDANCE_UNAVAILABLE` e `AGGREGATES_UNAVAILABLE`. `activitiesComplete` informa separadamente se a coleção de atividades foi integralmente lida. Não confundir ausência de frequência com faltas zero.

## Leitura, limites e falhas

São reutilizados `UsersRepository`, `AcademicStructureRepository`, `ActivitiesRepository` e `GradesRepository`. As leituras de vínculos e atividades são paginadas com contagens; consultas por conjuntos de IDs são divididas em lotes. As notas são filtradas no banco por tenant, Auth do aluno e atividades autorizadas. Cada chamada lê novamente a persistência: lançamento/alteração legítima de nota aparece no próximo overview.

Limites do contrato:32 períodos,100 ofertas por overview,1000 atividades/avaliações por disciplina; escopo interno limitado a3200 vínculos/ofertas. Há também orçamento global por chamada: overview até100 ofertas e1000 atividades; history até320 ofertas e2000 atividades; no máximo500 consultas de repository e aproximadamente2MiB de conteúdo serializável, com reserva para envelopes. O limite que for atingido primeiro interrompe novas leituras. Excesso produz `ACADEMIC_LIMIT_EXCEEDED` e `complete:false`; coleções de atividades afetadas têm `activitiesComplete:false`. Nenhum texto é cortado para caber: a cauda da coleção fica explicitamente parcial.

Em catálogos com mais de32 períodos, a seleção é um subconjunto por ID, ordenado por código depois de lido; catálogo e histórico são parciais. Overview padrão consulta períodos ativos separadamente quando necessário, e um `periodId` explícito pode localizar outro período persistido do mesmo tenant. Esses limites exigem evolução de contrato/paginação para instituições maiores. As consultas não constituem um snapshot transacional único; alterações concorrentes podem exigir nova consulta. Uma contagem incompatível com páginas lidas produz aviso de dados incompletos. Atividades usam ordenação por prazo e ID para desempatar datas iguais/nulas.

Título, descrição, tipo de atividade e feedback individual aceitam até102400 caracteres, compatíveis com o limite de corpo JSON100kb já utilizado pela API. Textos acima de2000 aceitos nas rotas anteriores são preservados integralmente; o orçamento global da resposta continua valendo. As demais restrições dos contratos genéricos permanecem.

Oferta legada sem disciplina/período, referência ausente ou associação inconsistente não é adivinhada: `ACADEMIC_DATA_INCOMPLETE`, `complete:false` e apenas associações seguras são retornadas. O cadastro/mapeamento e a matrícula reais são responsabilidade institucional.

Erros de repositories não se tornam listas vazias de sucesso. O serviço preserva `HttpError` controlado somente para a implementação nativa confiável: indisponibilidade retorna503, resposta inválida502, falhas internas500; erros externos ou inesperados continuam sanitizados. Nenhuma mensagem SQL, stack ou dado pessoal é registrado/retornado. Os formatos e a operação de logs estão em [observability.md](observability.md).

## Validação e dependências

Jest usa exclusivamente fixtures sintéticas e mocks, incluindo integração HTTP login→overview, alteração de nota, zero/null, ausência/múltiplos vínculos, histórico, docentes, isolamento, dados incompletos, limites e falhas. O smoke compilado verifica os providers demo e nativo e bloqueia chamadas externas.

Etapa6 não cria migration. Ordem de dependências: base → `20261026000001_security_integrity.sql` → `20261026000002_academic_structure.sql` → `20261026000003_institutional_management.sql`. Após autorização explícita somente para PostgreSQL local descartável, o runner institucional passou nas86 verificações em PostgreSQL16, cobrindo constraints, locks, concorrência e privilégios da RPC com dados sintéticos. O gate da API foi repetido:301 testes/24 suítes, typecheck, build e smoke aprovados. Esse resultado local não comprova o estado remoto: as migrations e o mapeamento real do legado continuam pendentes de aplicação manual autorizada no ambiente de destino.

Frontend com decodificador estrito precisa aceitar `assessments`, `title`, campos adicionais de usuário e `error.requestId`. Aplicativos que leem somente médias não exibirão as notas individuais nativas até uma adaptação futura. Nenhuma alteração de Flutter ou painel web foi realizada. Entregas avançadas, frequência completa, chat, WebSocket e notificações não foram implementados; a execução termina na Etapa6.
