# UniConnect — Plano de estabilização: painel admin e API

> Documento de trabalho. Manter atualizado conforme decisões forem fechadas.
> Colocar na raiz de `uniconnect-clients` e `uniconnect-api`.

---

## 1. Hierarquia de perfis (decisão crítica)

O painel tem três níveis de acesso. O backend deve tratar como papéis
distintos, nunca como flags booleanas.

| Perfil | Escopo | O que pode fazer |
|---|---|---|
| Admin global | Toda a plataforma | Criar/desativar tenants, ver métricas globais, acessar qualquer instituição |
| Gestor institucional | Um tenant | Gerenciar usuários, cursos, turmas, permissões dentro da sua instituição |
| Coordenador/professor | Parcial dentro de um tenant | Ver relatórios do seu escopo, gerenciar turmas/atividades que lhe pertencem |

### Decisões em aberto (resolver antes de construir o painel)

- [ ] O coordenador/professor acessa o painel web ou apenas o app mobile?
- [ ] Um usuário pode ter papéis diferentes em tenants diferentes?
- [ ] O admin global opera acima dos tenants ou tem tenant próprio?
- [ ] A autenticação do painel usa o mesmo `/auth/login` do app mobile?

---

## 2. Ordem de execução das sessões

```
AGORA — em paralelo:
  ├── App mobile:  sessão 1 — infra, Flutter, independe da API
  └── API:         sessão A — completar /auth/me com role e tenantSlug

Assim que sessão A terminar:
  ├── App mobile:  sessão 2 — auth e tenant (depende de role no /auth/me)
  └── API:         sessão B — usuários, cursos, turmas

Assim que sessão 2 terminar:
  ├── App mobile:  sessão 3 — guards de perfil (depende de role)
  ├── App mobile:  sessão 4 — telas e README (independe da API)
  └── API:         sessão C — atividades, notas, relatórios, testes Jest

Depois — quando API sessão B estiver pronta
e decisões de produto da seção 6 estiverem fechadas:
  └── Painel web:  blocos A → B → C → D → E → F
```

---

## 3. Stack confirmado

| Camada | Tecnologia |
|---|---|
| App mobile | Flutter + Riverpod + GoRouter |
| API | Node.js + TypeScript + Express + Supabase Auth + Supabase Postgres |
| Painel web | A confirmar (manter o que existe no repositório) |
| Banco | Supabase Postgres com RLS |
| Auth | Supabase Auth — Bearer token, não JWT próprio |

---

## 4. Contrato mínimo da API

### 4.1 Autenticação

```
POST /api/v1/auth/login
  header: x-tenant-slug (gestor/coordenador — admin global não envia)
  body: { email, password }
  response: {
    accessToken, refreshToken, expiresAt,
    user: { id, name, email, role, tenantSlug }
  }

GET /api/v1/auth/me
  header: Authorization: Bearer <token>
  header: x-tenant-slug
  response: { id, name, email, role, tenantSlug }

POST /api/v1/auth/logout
  header: Authorization: Bearer <token>
  response: 204

POST /api/v1/auth/refresh
  status: 501 (stub documentado — implementar quando contrato fechado)
```

### 4.2 Gestão de tenants (admin global)

```
GET    /api/v1/admin/tenants
POST   /api/v1/admin/tenants       body: { name, slug, plan, contactEmail }
GET    /api/v1/admin/tenants/:slug
PUT    /api/v1/admin/tenants/:slug
PATCH  /api/v1/admin/tenants/:slug/status   body: { active: bool }
```

### 4.3 Usuários (gestor + admin)

```
GET    /api/v1/tenants/:slug/users          query: role?, search?, page?, limit?
POST   /api/v1/tenants/:slug/users          body: { name, email, password, role }
GET    /api/v1/tenants/:slug/users/:id
PATCH  /api/v1/tenants/:slug/users/:id/role body: { role }
DELETE /api/v1/tenants/:slug/users/:id
```

### 4.4 Cursos e turmas (gestor + coordenador parcial)

```
GET    /api/v1/tenants/:slug/courses
POST   /api/v1/tenants/:slug/courses              body: { name, description? }
GET    /api/v1/tenants/:slug/courses/:id
PUT    /api/v1/tenants/:slug/courses/:id
DELETE /api/v1/tenants/:slug/courses/:id

GET    /api/v1/tenants/:slug/courses/:id/classes
POST   /api/v1/tenants/:slug/courses/:id/classes  body: { name, teacherId? }
GET    /api/v1/tenants/:slug/classes/:id
PUT    /api/v1/tenants/:slug/classes/:id
DELETE /api/v1/tenants/:slug/classes/:id
```

### 4.5 Atividades e notas (professor com escopo limitado)

```
GET    /api/v1/tenants/:slug/classes/:id/activities
POST   /api/v1/tenants/:slug/classes/:id/activities  body: { title, description?, dueDate?, type? }
GET    /api/v1/tenants/:slug/activities/:id
PUT    /api/v1/tenants/:slug/activities/:id
DELETE /api/v1/tenants/:slug/activities/:id

GET    /api/v1/tenants/:slug/activities/:id/grades
PUT    /api/v1/tenants/:slug/activities/:id/grades/:studentId  body: { grade, feedback? }
GET    /api/v1/tenants/:slug/students/:studentId/grades
```

### 4.6 Relatórios

```
GET /api/v1/tenants/:slug/reports/summary
GET /api/v1/tenants/:slug/reports/engagement  query: from?, to?, courseId?
GET /api/v1/admin/reports/global              (admin global, sem x-tenant-slug)
```

---

## 5. Convenções obrigatórias da API

Fechar antes de construir qualquer tela do painel:

- **Paginação**: `{ data: [], meta: { page, limit, total } }`
- **Erros**: `{ error: { code: string, message: string } }` — sem stack trace
- **Datas**: ISO 8601 UTC
- **IDs**: UUID v4
- **Soft delete**: definir se usa `deletedAt` ou hard delete
- **CORS**: origem do painel web na lista de origens permitidas
- **Rate limit**: definir antes de ir para produção

---

## 6. Telas do MVP do painel (ordem de construção)

### Bloco A — Auth e shell (pré-requisito de tudo)
1. Login com resolução de tenant
2. Shell com sidebar e header
3. Guard de perfil por role

### Bloco B — Usuários
4. Listagem com busca e filtro por perfil
5. Criação/edição de usuário
6. Gestão de permissões

### Bloco C — Cursos e turmas
7. Listagem de cursos
8. Detalhe do curso com turmas
9. Criação/edição de curso e turma

### Bloco D — Atividades e notas
10. Listagem de atividades por turma
11. Lançamento de notas

### Bloco E — Relatórios
12. Dashboard de métricas do tenant
13. Dashboard global (admin)

### Bloco F — Gestão de tenants (admin global)
14. Listagem de tenants
15. Criação e configuração de tenant

---

## 7. Decisões técnicas do painel (já tomadas)

- **Framework**: manter o que existe no repositório.
- **Estado**: manter o padrão já adotado no painel existente.
- **Fonte**: Inter local, sem runtime fetching — igual ao app mobile.
- **Token storage**: `httpOnly cookie` preferencialmente. Se inviável
  no backend atual, `localStorage` com dívida de segurança documentada.

---

## 8. Pendências que bloqueiam a construção do painel

### Dependem do backend
- [ ] `/auth/me` retorna `role` e `tenantSlug` → **sessão A da API**
- [ ] Formato de erro padronizado em todos os endpoints
- [ ] CORS configurado para a origem do painel web
- [ ] Soft delete definido
- [ ] `/auth/refresh` implementado (hoje está como stub 501)

### Dependem de decisão de produto
- [ ] Coordenador/professor acessa o painel ou só o app mobile?
- [ ] Como o tenant é resolvido no login do painel (subdomínio, campo ou seleção)?
- [ ] Um usuário pode ter papéis em múltiplos tenants?
- [ ] Admin global opera acima dos tenants ou tem tenant próprio?
- [ ] Onboarding de nova instituição: manual pelo admin ou self-service?
