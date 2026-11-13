# FCM acadêmico — configuração manual no Portainer

## Escopo entregue

- `POST /api/v1/tenants/:slug/notifications/devices` registra o token FCM do dispositivo para o usuário autenticado.
- `DELETE /api/v1/tenants/:slug/notifications/devices` remove somente o vínculo pertencente ao usuário e à instituição autenticados.
- Ambos recebem `{ "token": "<token FCM obtido pelo SDK Flutter>" }`, exigem bearer e `x-tenant-slug`, validam o corpo e respondem 204. Não enviar IDs de usuário ou instituição no corpo. Não registrar o corpo ou token em logs.
- A publicação bem-sucedida de atividade pelo docente atribuído dispara `activity_published` para dispositivos de alunos com matrícula ativa na turma e no tenant. Payload inclui `activityId`, `classId` e `tenantId`; nenhum conteúdo da resposta acadêmica é enviado.
- Criar rascunho, rejeitar uma publicação, fechar atividade ou desabilitar FCM não dispara essa notificação.
- Firebase usa Application Default Credentials e `firebase-admin@14.5.1`. Falhas no push são contidas e não revertem nem atrasam a resposta de publicação já confirmada.
- O runtime permanece Node 22. O override de `@firebase/database-compat` para `2.1.7` mantém a cadeia transitiva Firebase compatível com Node 22 (`@firebase/database@1.1.5`), evitando as versões posteriores que exigem Node 24. Não atualizar essa cadeia sem conferir os engines.
- Não há envio FCM de notas ou chat nesta entrega. O chat Realtime e as notificações internas existentes permanecem independentes.

O registro de dispositivos é **em memória**, sem tabelas ou migrations. Reiniciar/recriar a API perde os vínculos: o cliente precisa registrar novamente após login/restauração. Esta versão exige uma única instância/processo para que registros e envios compartilhem o mesmo mapa. Não há fila durável, retentativa persistente ou garantia de entrega de um push em caso de reinício; não escalar horizontalmente esperando compartilhar esses vínculos.

## Valores não secretos

| Configuração | Valor |
| --- | --- |
| Repositório Git da stack | `https://github.com/ykiakao/uniconnect-api` |
| Referência acompanhada | `refs/heads/main` |
| Compose | `docker-compose.yml` |
| `FCM_ENABLED` | `true` para habilitar; padrão `false` |
| `FIREBASE_PROJECT_ID` | `uniconnect-b9c75` |
| `FIREBASE_ADMIN_CREDENTIALS_HOST_PATH` | Exemplo: `/opt/uniconnect/secrets/firebase-admin.json` — caminho absoluto no **host Docker**, não no computador Windows nem no checkout Git |
| `GOOGLE_APPLICATION_CREDENTIALS` no container | `/run/secrets/firebase-admin.json`, fixado pelo Compose |
| Supabase autorizado para esta validação | `https://pvacwfypqsstdrfxajkg.supabase.co` |
| API pública | `https://api-uni.juancjc.com.br/api/v1` |

O Compose monta um arquivo por bind mount com `read_only: true` e `create_host_path: false`. **Essa montagem é obrigatória mesmo com `FCM_ENABLED=false`**: antes de atualizar para este Compose, preparar o arquivo e a variável de caminho. Isso impede criar acidentalmente um diretório no lugar da credencial. Desabilitar FCM interrompe envios, mas não elimina a exigência de montagem.

## Preparação do arquivo privado no host

1. Usar uma conta de serviço autorizada a enviar FCM no projeto `uniconnect-b9c75`. Confirmar projeto e acesso à API Cloud Messaging, sem publicar o JSON nem suas chaves.
2. Disponibilizar o JSON pelo procedimento privado do operador, fora do repositório e do diretório de build. Ele não deve ser enviado ao chat, editor da stack ou logs.
3. Garantir que o arquivo existe, é um arquivo regular e pode ser lido pelo usuário `node` da imagem (UID 1000), sem torná-lo legível globalmente. A montagem somente leitura impede gravação pelo container; as permissões de leitura são as do host.
4. Se houver vários nós Docker, o arquivo deve existir no nó que executará o serviço. O caminho de bind mount é resolvido no daemon Docker. A stack existente usa build local; não converter a implantação para Swarm nesta entrega.

O Dockerfile copia somente fontes e manifests explícitos. O `.dockerignore` exclui todos os JSON do contexto, exceto os quatro manifests/configurações de build, além de diretórios de credenciais e arquivos de chave. O `.gitignore` bloqueia os nomes comuns de credenciais Firebase. Um JSON privado com nome arbitrário também deve permanecer fora do checkout; não usar `git add -f` para incluí-lo.

## Atualização manual — somente após aprovação de publicação e autorização operacional

1. Publicar o código aprovado em `main` por push normal, conferir o SHA remoto e confirmar que todos os commits anteriores continuam ancestrais. A preparação do código não autoriza deploy.
2. No Portainer, confirmar o repositório, `refs/heads/main`, Compose e GitOps automático **desativado**. Conferir `SUPABASE_URL` exatamente no projeto TEST autorizado. Não trocar chaves, origens CORS ou configurações acadêmicas que já funcionam.
3. Acrescentar `FCM_ENABLED=true`, `FIREBASE_PROJECT_ID=uniconnect-b9c75` e o caminho privado em `FIREBASE_ADMIN_CREDENTIALS_HOST_PATH`. O Compose já encaminha essas configurações e fixa o caminho interno de ADC.
4. Quando o operador autorizar a operação, atualizar a stack a partir do SHA aprovado e reconstruir a imagem; só reiniciar o container antigo não incorpora o código novo. Nenhuma migration é necessária para FCM.
5. Conferir health/liveness e readiness pela rotina existente, imagem/SHA efetivos, existência e leitura da montagem sem exibir seu conteúdo. Não usar dumps de ambiente que mostrem chaves Supabase.
6. Com um cenário sintético autorizado, entrar no Flutter, confirmar POST 204, publicar uma atividade de teste com professor vinculado e conferir recebimento no Samsung do aluno matriculado. Notificação direta do Console não comprova a integração da API.
7. Conferir DELETE 204 antes do logout, ausência de novas seleções do dispositivo para o usuário anterior e funcionamento de atividades, notas, painel e chat. Considerar mensagens já em trânsito.
8. Após qualquer reinício da API, encerrar/reabrir o processo Flutter e restaurar a sessão, ou sair/entrar, para registrar o dispositivo novamente. Apenas voltar do background não garante novo registro. Não há polling nem persistência nesta versão.

Para conter um problema de envio, o operador pode desabilitar FCM e atualizar manualmente a stack. Manter o arquivo montado; isso não altera dados acadêmicos. Erros FCM são registrados genericamente, sem token ou mensagem privada da exceção.

## Validação local

```text
npm run typecheck
npm run build
npm run test:push
npm test -- --runInBand
docker build -t uniconnect-api:fcm-review-20261113 .
```

Os testes Jest usam Supabase e Firebase simulados. Build de imagem e testes não são deploy. Não executar scripts de banco, seed, smoke remoto ou SQL como parte desta preparação.

Referências: [Firebase Admin e ADC](https://firebase.google.com/docs/admin/setup), [bind mounts no Compose](https://docs.docker.com/reference/compose-file/services/#volumes).
