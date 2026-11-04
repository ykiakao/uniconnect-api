# UniConnect API · Preparação para publicação

**Referência** 04/11/2026
**Branch** `publish/api-clean-2026-11-04`
**Base** `origin/main` em `d4bf725b50c3a38ce45d0acec4ac858e4ea54976`

A entrega seleciona os arquivos da candidata auditada em um worktree isolado. A [API](../README.md) inclui sessão e recuperação de conta, autorização por tenant, gestão institucional, trabalhos e submissões versionados, correção e publicação, provas N1/N2, boletim, fechamento e comunicação HTTP. O provider de demonstração usa dados sintéticos. O provider nativo consulta dados do próprio UniConnect. A seleção altera 222 arquivos em relação à base, com 171 adições, 48 modificações e três renomes. Ficaram fora 19 arquivos exclusivos do conector privado de portal, entre pacote, adaptadores e testes, além de 15 entradas do lockfile. As versões das dependências mantidas foram preservadas. A infraestrutura da base foi preservada. A auditoria não acessou o Supabase e nenhuma migration foi executada.

O inventário reproduzível da seleção, incluindo os renomes de SQL, pode ser consultado com `git diff --find-renames --name-status origin/main...HEAD` nesta branch. Os relatórios brutos e a comparação com a candidata ficam fora da árvore de entrega.

## Sessão, refresh e logout

- Em `origin/main`, `POST /api/v1/auth/refresh` devolve `501 NOT_IMPLEMENTED`, compatível com a resposta reportada no Portainer. O commit efetivamente implantado não foi identificado.
- Nesta branch, o Supabase Auth emite o JWT e o refresh token no login. A API usa o prazo do provedor, devolvido ao cliente em `expiresAt`, e valida o Bearer com `getUser`. Os endpoints institucional e administrativo renovam a sessão pelo SDK em cliente isolado, revalidam o novo JWT, a identidade, o tenant, o vínculo e o papel. Se o acesso for negado após rotação, nenhum token é devolvido e pode ser necessário entrar novamente.
- A rotação é responsabilidade do Auth. Sessão expirada, revogada ou reutilização rejeitada pelo provedor retornam `401 INVALID_SESSION`. A tolerância à reutilização e os efeitos de concorrência dependem da configuração do Auth. O logout delega ao Auth e retorna `204`. Um JWT já emitido pode permanecer válido até expirar.
- O Flutter restaura a sessão persistida no armazenamento seguro quando habilitado, verifica expiração, tenta renovar ao receber `401 INVALID_SESSION` e repete a requisição protegida uma vez. O teste da API confirma HTTP e uso do SDK com GoTrue simulado. Renovação automática com Flutter e Auth reais, inclusive após expiração e após logout, permanece sem validação nesta entrega. Consulte [contas e sessões](accounts-and-sessions.md).

## Migrations incluídas

| Arquivo | Dependências e efeito |
| --- | --- |
| `20261103185100_activity_assessment_plan.sql` | Parte da estrutura acadêmica e do workflow de atividades. Acrescenta metadados de avaliação e RPC de edição versionada. |
| `20261103190038_in_person_exam_grades.sql` | Usa plano de avaliação, workflow e comunicação. Acrescenta abertura da pauta, unidade da nota e RPCs de provas. |
| `20261103190622_academic_report_cards.sql` | Depende das notas e provas versionadas, chaves compostas e matrículas. Cria o fechamento com RLS e restringe a execução das RPCs. |
| `20261104000001_service_role_academic_privileges.sql` | Depende das tabelas e versões anteriores. Concede ao `service_role` os acessos a tabelas e colunas usados nas operações acadêmicas. |

A revisão estática indica compatibilidade esperada com PostgreSQL 17. A aplicação requer identidade autorizada a alterar as tabelas e funções, definir RLS e conceder os privilégios previstos. As RPCs acadêmicas privilegiadas exigem `service_role` no servidor. A auditoria não verificou grants efetivos e herança, proprietários de funções, regras para criação no schema `public` ou o efeito de `search_path` no ambiente de destino. Também ficam pendentes a aplicação em PostgreSQL 17, a verificação de locks e dados legados e a reconciliação das três migrations antigas renomeadas com o ledger do ambiente. Esses renomes preservam o conteúdo dos arquivos.

O harness usa PostgreSQL 16 e seu manifesto versionado omite as quatro migrations da tabela. A suíte offline verifica contratos de planejamento, limites e fixtures. Ela não aplica SQL nem qualifica as permissões de PostgreSQL 17. Um ensaio anterior com manifesto temporário chegou até a leitura docente da entrega. Nesta etapa o harness não foi iniciado.

## Evidências da validação

Node.js **22.23.4**, npm **11.9.0**. Instalação pelo lockfile em cache, com scripts de instalação desabilitados. Testes e smoke usaram fixtures sintéticas.

| Verificação | Resultado |
| --- | --- |
| `npm test -- --runInBand` | **969 testes em 54 suítes**, todos aprovados. Os 13 testes exclusivos do conector ficaram fora. |
| Jest dirigido a autenticação, autorização, tenant, acadêmico, submissões, notas e segurança | **413 testes em 29 suítes**, todos aprovados. |
| Jest dirigido a refresh HTTP, SDK e serviço de sessões | **39 testes em 3 suítes**, todos aprovados. |
| `node --test scripts/tests/homologation-migrations.test.cjs scripts/tests/offline-contracts-prototype.test.cjs` | **182 aprovados**, sem banco. |
| `npm run typecheck` e `npm run build` | Ambos aprovados. |
| `npm run test:academic-build` | Health **200**, rotas protegidas **401** sem credencial, CORS indevido **403**, contrato de nota zero, providers demo e nativo. Sem chamadas externas. |
| `git diff --check` | Sem apontamentos na seleção preparada. |
| Gitleaks 8.30.1 | Zero alertas nos 17 commits de `origin/main`, no diff preparado e nos arquivos rastreados preparados. |
| `npm audit` | 12 entradas na árvore de desenvolvimento, 8 moderadas e 4 baixas, relacionadas a `glob`, `minimatch` e `deepmerge` e suas dependências. |
| `npm audit --omit=dev` | Zero vulnerabilidades reportadas na árvore de produção. |

Os 172 alertas históricos reportados na candidata pertencem à outra ancestralidade. O escopo desta entrega é a árvore final e todos os commits alcançáveis pela nova branch. A ausência de alertas nesse escopo não reclassifica as ocorrências da candidata.

## Critério para entrega

**GO para revisão técnica e publicação do código após autorização. NO-GO para homologar ou implantar com as evidências atuais.** As 12 entradas do audit estão restritas à árvore de desenvolvimento e ficam registradas para manutenção. Para homologar, validar o schema e os privilégios efetivos em PostgreSQL 17, a política de sessão do Auth, o refresh real após expiração, o isolamento entre tenants e o ciclo acadêmico até a devolutiva publicada. A publicação depende de autorização posterior.
