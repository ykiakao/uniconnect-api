# Fase A — anexos acadêmicos no backend

Base: `0e29cd2e8d6c5b24e94e3b2e0270df36a783847a`. Branch: `feat/academic-attachments-phase-a`.
Escopo autorizado: backend, documentação, testes locais e migration como arquivo. Sem clientes, Supabase remoto, publicação ou laboratório congelado.

- [x] Ler proposta integralmente, identificar estado Git e preservar checkout original.
- [x] Isolar worktree. A ferramenta gerenciada não respondeu; fallback Git local confirmado, sem stash.
- [x] Executar baseline no Node 22: 59 suítes / 1.025 testes aprovados.
- [x] Escrever testes de validação de bytes; observar RED; implementar parsers com limites e worker encerrável.
- [x] Gerar migration com CLI local: tabelas, FKs compostas, ACL/RLS, RPCs de autorização, reserva, conclusão, vínculos e envio atômico.
- [x] Executar SQL em PostgreSQL embarcado descartável, sem destinos de rede; cobrir ACL, identidade, versões e falhas.
- [x] Implementar adaptador Storage privado: capacidade temporária, leitura limitada, escrita final sem sobrescrita e download de 60 segundos.
- [x] Implementar serviço e rotas com modo disabled/read_only/enabled, idempotência e leases.
- [x] Integrar somente o contrato/backend de entrega textual, recibos e histórico, preservando o fluxo antigo com recurso desligado.
- [x] Implementar reconciliação e limpeza dry-run por padrão; bloquear execução remota nesta fase.
- [x] Documentar todos os endpoints e decisões para frontend em `docs/academic-attachments-api.md`.
- [x] Executar testes novos, regressão acadêmica, typecheck e build no Node 22; revisar diff e segurança; corrigir findings.
- [x] Verificar preservação do checkout original, SQL histórico e arquivos Realtime; entregar relatório sem commit/push/PR/deploy.

Decisões explícitas: texto permanece obrigatório; omitir `attachmentIds` significa conjunto vazio; materiais congelam após primeira entrega; provas presenciais e legado sem workflow ficam fora da escrita; URLs já emitidas têm janela residual. Reserva repetida pode retornar apenas estado sem nova capacidade; cancelar e reservar com outra chave recupera um token perdido.

Ambiente: Docker local indisponível. PGlite será usado para integridade/SQL sequencial; não comprova múltiplas conexões ou Storage/CDN reais. Esses ensaios permanecem pendentes e serão registrados. Node do host é 24; comandos de verificação usam Node 22 via pacote local de ferramenta.

Verificação final: Node 22.23.5; 63 suítes/1.065 testes Jest, 14 testes SQL PGlite, 4 de limpeza e 2 de orçamento PDF aprovados; typecheck/build e smoke do worker compilado aprovados. Revisão independente sem P1/P2 abertos após correções. Ensaios reais de Storage, múltiplas conexões e Docker continuam pendentes; isso não autoriza ativação. HEAD permaneceu o da base; sem commit/push/PR/deploy.
