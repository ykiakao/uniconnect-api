# Consolidação local da API — 09/11/2026

## Escopo e identidade

- Branch local: `codex/consolidate-api-2026-11-09`.
- Base confirmada no remoto: `main`, `0ad5e8ae8e2b1e3d439e1d9c07bf6ef6ccec1631`.
- Integração: `codex/integration-chat-realtime`, `b4a19177d8723bbe3a691a7d10ff7824709c22f9`.
- A branch `publish/api-clean-2026-11-04`, `888744ecf4dc1f7b220ea9850c0f2bca0fa41c35`, já é ancestral da branch do chat.
- Um único `git merge --no-ff --no-commit` da branch do chat foi realizado no worktree isolado, partindo da main remota confirmada. O commit de merge é local; consultar seu identificador com `git rev-parse HEAD` nessa branch.
- Sem push, PR, integração na main, deploy ou conexões ao Supabase. Nenhuma migration, patch, seed, login real, mensagem ou recibo executado. Portainer, PG17, containers e volumes existentes não foram alterados.

## Resolução dos conflitos

| Arquivo | Decisão |
| --- | --- |
| `.env.example` | Preservar configuração atual da API, campos de segredo vazios e `API_EXTERNAL_PORT=3333` da infraestrutura da main. Sem restaurar senhas de demonstração padrão |
| `README.md` | Manter contratos e documentação atualizados, recuperar operação Docker/Portainer e distinguir configurações legadas de Render/Railway da implantação informada pelo operador. Registrar requisitos de configuração e banco sem executar alterações |
| `src/app.ts` | Manter todas as proteções/middlewares/rotas do chat e o readiness da main antes das rotas protegidas. Registrar readiness na observabilidade. Preservar status/estrutura 200 e 503; sanitizar somente a mensagem de erro da dependência |

O teste de readiness da main foi mesclado automaticamente e preservado. Foram acrescentadas verificações de falha 503 sem detalhes internos, liveness independente do banco e observabilidade. A lógica de autenticação, listagem e chat permanece a da branch de integração.

## Arquivos específicos da consolidação

Delta em relação à branch do chat:

1. `.dockerignore` — recuperado da main, sem alterações.
2. `Dockerfile` — recuperado da main, sem alterações.
3. `docker-compose.yml` — recuperado da main, sem alterações.
4. `.env.example` — resolução descrita acima.
5. `README.md` — resolução descrita acima.
6. `src/app.ts` — resolução descrita acima.
7. `src/app.test.ts` — teste original preservado e cobertura adicional de readiness.
8. `src/modules/users/users.list.http.test.ts` — papéis administrativos, bloqueio de professor/aluno, tenant divergente, ausência de vínculo, vínculo inativo, paginação, contrato React e proteção de campos internos.
9. `src/modules/users/users.list.repository.test.ts` — SDK Supabase real com fetch interceptado, conferindo filtros de tenant/papel/busca, ordenação, paginação e contagem. Sem rede.
10. `.gitattributes` — `eol=lf` exclusivamente para o SQL de Broadcast, preservando o hash aprovado em checkouts Windows com `core.autocrlf=true`.
11. Este relatório — evidências, limitações e rollback.

Os demais arquivos são herdados da consolidação publicada da API e dos dois commits de chat já revisados. Nenhum arquivo SQL foi editado semanticamente; seu conteúdo Git é idêntico ao da branch do chat.

## Validação executada

Node utilizado: **22.23.4**. Dependências instaladas com `npm ci` e lockfile correspondente, sem atualização do manifesto ou lockfile. Os comandos npm abaixo também foram executados diretamente por seus binários locais com esse Node.

| Verificação | Resultado |
| --- | --- |
| Baseline da main: Jest completo antes da integração | PASS, 32 testes / 7 suítes |
| `npm run typecheck` (`tsc --noEmit`) | PASS |
| `npm run build` | PASS |
| `npm test -- --runInBand --no-cache` | PASS, **1.020 testes / 58 suítes**, zero falhas |
| `node --test scripts/tests/homologation-migrations.test.cjs` | PASS, **116 testes**, zero falhas; sentinelas impedem rede, cliente PostgreSQL e execução SQL |
| `node scripts/academic-production-smoke.cjs` | PASS, código compilado em loopback, health 200, autenticação obrigatória, CORS de produção explícito, no-store/requestId; zero chamadas externas |
| Compose: `docker compose --project-name uniconnect-consolidation-review --env-file NUL config --quiet` | PASS, somente placeholders sintéticos em memória; serviço único `uniconnect-api`, sem volumes declarados; nenhum `up` |
| Docker: `docker --context desktop-linux build --tag uniconnect-api-consolidation:2026-11-09 .` | **BLOQUEADO**, exit 1: pipe `dockerDesktopLinuxEngine` ausente. Nenhuma imagem construída ou serviço iniciado |
| Comparação de Dockerfile, .dockerignore e Compose contra a main | PASS, conteúdo Git idêntico |
| `git diff --cached --check` e conflitos pendentes | PASS, zero erros e zero entradas unmerged |
| Arquivos de ambiente privados e assinaturas de segredo no staging | Nenhum arquivo privado encontrado; nenhuma assinatura de chave privada, JWT completo ou chave Supabase secreta nos arquivos versionados. Verificação por padrões, sem garantia universal de detecção |
| Revisão independente das resoluções e testes | Sem findings bloqueantes no escopo da consolidação |

Os testes de autenticação e dados usam mocks ou fetch interceptado. Eles não comprovam autenticação ou persistência em um serviço remoto e não substituem o ensaio de entrega real do chat. Não foram copiados perfis privados para o worktree.

SHA-256 do arquivo local `supabase/scripts/chat-realtime-broadcast.sql`, conferido após preservar LF:

```text
31e9ad4d8dceae53f5ec75df4231d7e72a7ff7eda83b807183c17dd3bce7bd63
```

## Pendências e compatibilidade

- **Build Docker:** falta executar com daemon Linux disponível em ambiente isolado. A validação offline do Compose não comprova instalação das dependências de produção, imagem construída ou execução do runtime no container. Não iniciar o Docker Desktop automaticamente, pois isso pode reativar recursos existentes congelados.
- **Configuração:** o Compose preservado não encaminha as variáveis opcionais de allowlist da plataforma, provider acadêmico e redirects Auth. A necessidade desses recursos no destino deve ser alinhada antes de qualquer deploy, em alteração separadamente autorizada. Os padrões de segurança não foram flexibilizados.
- **Banco de destino:** envio do chat exige `academic_chat_send` e as estruturas/políticas compatíveis. O patch foi confirmado anteriormente apenas em teste. Na ausência das dependências, o backend retorna `DATABASE_MIGRATION_REQUIRED`; não há fallback que contorne a proteção.
- **Chat real:** entrega Broadcast, escrita/persistência e recibos reais ainda dependem do ensaio autorizado, respeitando a janela de segunda a sexta, 13h–18h, America/Rio_Branco. A consolidação não introduz exceção de horário.
- **Lista de alunos:** listagem institucional e contrato React existentes estão cobertos; filtros diretos por curso/turma e paginação dos lookups do painel continuam sendo trabalho separado. Não há ampliação de permissões para professor.
- **Deploy:** commit/imagem efetivamente em execução, branch monitorada pelo Portainer e automações de atualização não foram reconfirmados nesta tarefa. Antes de publicar código que possa ser monitorado, o operador deve confirmar que publicação/merge não dispara deploy não autorizado.

**Parecer técnico: GO para PR de revisão, com build Docker pendente e obrigatório antes de aprovar o merge. NO-GO para merge/deploy enquanto os gates aplicáveis não forem concluídos.** Publicação e criação de PR continuam aguardando autorização do operador.

## Rollback para uma integração futura

1. Antes de qualquer integração/deploy autorizado, registrar HEAD da main, commit integrado, imagem/tag/digest efetivamente em execução e configuração operacional vigente. Não presumir que o HEAD atual da main identifica a imagem implantada.
2. Se a integração usar merge commit, preparar uma branch de reversão e `git revert -m 1 <commit-efetivamente-integrado-na-main>`. Se usar squash, reverter o commit squash com `git revert <commit-squash>`. Validar a reversão e submetê-la à revisão; sem reset ou force-push da main.
3. Publicar/mesclar a reversão somente com autorização. Alterar Git não autoriza troca da imagem no Portainer.
4. Caso também tenha havido deploy, restaurar a imagem/digest anterior somente em operação de deploy autorizada, conferir liveness/readiness, autenticação e tenant. Considerar que a versão anterior pode não oferecer os contratos recentes do painel/chat.
5. Esta consolidação não altera banco; portanto, sua reversão não exige SQL de rollback. Preservar mensagens, recibos, políticas e todos os dados existentes. Se houver aplicação SQL futura e separada, ela exigirá plano e autorização próprios; não remover objetos como parte da reversão de código.
