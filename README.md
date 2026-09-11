# 🍔 BurgerHub

SaaS multi-tenant de atendimento e gestão para hamburguerias — painel administrativo, KDS (cozinha), cardápio digital, estoque com baixa automática, financeiro e integração WhatsApp (Evolution API).

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React 18 + TypeScript + TailwindCSS v4 + Vite + Recharts + dnd-kit |
| Backend | Node + Express + TypeScript + Zod |
| Banco | Prisma ORM — PostgreSQL (Neon) |
| Auth | JWT com hierarquia de papéis (Admin → Gerente → Caixa → Atendente → Cozinha/Entregador) |
| Deploy | Vercel — dois projetos (api + web) + Postgres via integração Neon |

## Rodando localmente

```bash
npm install
npm run db:push      # aplica o schema no banco (ver apps/api/.env)
npm run db:seed      # dados demo
npm run dev          # API (3333) + Web (5173) em paralelo
```

- **Painel:** http://localhost:5173 — `admin@burger.com` / `123456`
- **Cardápio digital:** http://localhost:5173/cardapio/burger-do-lu
- **API health:** http://localhost:3333/api/health

## Rodando online (produção)

- **Painel/cardápio:** https://burgerhub-web.vercel.app
- **API:** https://burgerhub-api.vercel.app
- **Banco:** Postgres via integração Neon (linkado ao projeto `burgerhub-api` na Vercel)

Arquitetura do deploy:
- `apps/api` é um projeto Vercel próprio. `api/index.ts` exporta o app Express como handler serverless (sem `app.listen`); `vercel.json` reescreve todas as rotas para essa função, então o Express continua roteando internamente com os prefixos `/api/...` de sempre.
- `apps/web` é outro projeto Vercel (Vite estático). `vercel.json` faz fallback de SPA (qualquer rota cai em `index.html`, necessário para o React Router funcionar em refresh direto). A variável `VITE_API_URL` (setada no projeto) aponta para a URL da API — é embutida no build, então mudar essa env exige um novo deploy.
- `DATABASE_URL`/`DATABASE_URL_UNPOOLED` são injetadas automaticamente pela integração Neon (a pooled é usada em runtime; a unpooled é usada por `prisma db push`/`migrate`, configurada como `directUrl` no schema).
- `prisma/src/lib/prisma.ts` usa um singleton em `globalThis` para não esgotar conexões entre invocações serverless.
- `WA_MOCK=true` e `MP_MOCK=true` estão ativos em produção (sem credenciais reais ainda) — troque quando for conectar WhatsApp/Mercado Pago de verdade.

Para redeployar depois de mudar código: `cd apps/api && vercel deploy --prod --yes` (idem para `apps/web`). Para mudar variáveis de ambiente: `vercel env add NOME production` dentro da pasta do projeto correspondente, seguido de um redeploy.

## Arquitetura

```
apps/
├── api/                    # Backend
│   ├── prisma/schema.prisma   # Modelagem completa (30+ modelos)
│   └── src/
│       ├── middlewares/       # auth (JWT + tenant), erros, rate limit
│       ├── modules/           # auth, catalog, orders, customers, coupons,
│       │                      # dashboard, stock, finance, settings, public
│       └── lib/, utils/, config/
└── web/                    # Frontend
    └── src/
        ├── components/ui/     # Design system (Button, Card, Modal, Skeleton...)
        ├── components/layout/ # AppShell (sidebar, dark mode)
        ├── pages/             # Dashboard, KDS, Pedidos, Produtos, Clientes,
        │                      # Cupons, Estoque, Financeiro, Relatórios, Config
        └── pages/menu/        # Cardápio digital público (mobile first)
```

### Multi-tenant

Todo modelo possui `tenantId` e **toda** query é escopada via `tenantOf(req)` extraído do JWT. As rotas públicas (`/api/public/:slug/...`) escopam pelo slug. Testado: um segundo tenant não enxerga nenhum dado do primeiro.

### Regras de negócio no servidor

- Preços de itens/adicionais **sempre** recalculados no backend (nunca confia no cliente).
- Máquina de estados de pedido com transições validadas (`NEW → PREPARING → ... → DELIVERED`).
- Baixa automática de estoque pela receita do produto (ingredientes removidos não são descontados); cancelamento devolve o estoque.
- Pedido entregue gera lançamento automático no financeiro.
- Cupons: percentual, valor fixo, frete grátis, 1ª compra, aniversário, validade e limite de usos.

## Etapas

- [x] **Etapa 1 — Fundação** (concluída e testada ponta a ponta)
  - Modelagem completa, API multi-tenant com JWT/RBAC/rate-limit/auditoria
  - Painel: Dashboard com KPIs e gráficos, **PDV de balcão com códigos curtos** (digite `1` ou `1*2` + Enter para lançar; códigos gerados automaticamente), Pedidos (com impressão térmica), KDS drag-and-drop com som e cronômetro, Produtos, Clientes (classificação VIP/Ouro/Prata/Bronze), Cupons, Estoque, Financeiro, Relatórios, Configurações (horários, zonas de entrega, equipe, WhatsApp, QR Code)
  - Cardápio digital mobile-first: busca, adicionais, remoção de ingredientes, upsell, carrinho, cupom, checkout, confirmação
- [x] **Etapa 2 — WhatsApp** (concluída e testada)
  - Conexão pelo painel **só com QR Code** — o lojista clica em "Conectar" e escaneia; toda a infraestrutura (servidor de mensagens, chaves, webhook) fica na plataforma via env (`WA_SERVER_URL`, `WA_SERVER_KEY`, `PUBLIC_API_URL`; `WA_MOCK=true` simula o fluxo em dev)
  - Bot de pedidos por conversa: cardápio com os códigos do PDV (`2x3` = 3 unidades), carrinho, entrega/retirada, endereço com detecção da região de entrega, pagamento, troco e confirmação — pedido cai direto no KDS com origem WHATSAPP
  - Mensagens automáticas de status (em preparo / saiu para entrega / entregue) pelo número conectado
- [x] **Etapa 3 — Pagamento online (Mercado Pago)** (concluída e testada)
  - Pix transparente no cardápio: QR Code + copia e cola na própria tela, com confirmação automática (polling + webhook `POST /api/payments/webhook/:tenantId`)
  - Cartão via Checkout Pro (redirecionamento seguro) com retorno para o cardápio e confirmação automática
  - Credenciais **por estabelecimento** (aba Pagamentos nas Configurações — o lojista cola o Access Token e o dinheiro cai na conta dele); o token nunca retorna ao navegador
  - Pedidos online ganham selo "✓ pago" / "aguardando pagamento" no KDS e no painel
  - `MP_MOCK=true` simula aprovação em dev; em produção basta o Access Token do lojista
- [x] **Etapa 3.1 — Frete automático por distância** (concluída e testada)
  - A taxa de entrega **nunca é escolhida pelo cliente** — o backend geocodifica o endereço (Nominatim/OpenStreetMap, sem chave) e calcula a distância real até o estabelecimento (Haversine), aplicando a faixa de km configurada pelo lojista
  - Configuração em Configurações → Entrega: botão "Detectar pelo endereço cadastrado" (geocodifica o próprio endereço da loja), raio máximo de entrega, e faixas tipo "até 3km = R$5, até 6km = R$8..."
  - Cardápio digital cota o frete em tempo real enquanto o cliente digita o endereço (rua/número/bairro/cidade), mostrando "Entrega R$X · Y km · ~Z min" ou o motivo caso esteja fora da área — pedido fica bloqueado até o frete ser calculado
  - Mesmo mecanismo usado no PDV e no bot do WhatsApp (endereço → cotação automática), substituindo o antigo sistema de zonas por bairro
  - Máscara de telefone `(XX) XXXXX-XXXX` no cardápio e no PDV — formata enquanto digita e nunca trava ao corrigir o DDD; o telefone é salvo só em dígitos no banco (mantém o mesmo cliente entre WhatsApp/cardápio/PDV)
  - Alternativa a digitar endereço: mapa clicável (Leaflet/OpenStreetMap) em Configurações → Entrega, e botão "Usar minha localização atual" (GPS + geocodificação reversa) no checkout do cardápio
- [x] **Etapa 3.2 — Avaliação pós-entrega + Auditoria** (concluída e testada)
  - Cliente recebe o link de avaliação real na mensagem de WhatsApp de entrega; página pública `/cardapio/:slug/avaliar/:orderId` com estrelas, NPS e comentário; card de nota média/NPS/comentários recentes em Relatórios
  - Log de auditoria (aba só para Admin/Gerente em Configurações) cobrindo login, cadastro, produtos, WhatsApp, mudança de status de pedido, CRUD de cupom/usuário/faixa de entrega, e alteração de config de pagamento (nunca loga o valor do token)
- [x] **Etapa 3.3 — Cadastro público + CORS restrito** (concluída e testada)
  - Página `/cadastro` (sem precisar de convite): nome da hamburgueria, endereço do cardápio (slug, sugerido automaticamente a partir do nome e editável), dono, e-mail, senha e telefone opcional — chama `POST /api/auth/register` (já existia) e loga automaticamente o novo dono no dashboard do próprio tenant, já isolado dos demais
  - Erro de slug já em uso (409) exibido direto no formulário; links cruzados entre `/login` e `/cadastro`
  - CORS deixou de estar totalmente aberto — a API só aceita requisições da origem do próprio painel (`PUBLIC_WEB_URL`)
- [x] **Etapa 3.4 — Upload de imagem + Mesas & POS de salão + Fidelidade** (concluída e testada)
  - Upload real de imagem de produto (Vercel Blob) em Produtos, com preview, fallback de link manual e fallback visual no cardápio digital
  - Mesas: nova tela `/mesas` — abrir mesa, lançar pedidos parciais (reaproveitando o padrão de código curto do PDV), fechar conta com seleção de pagamento e divisão por pessoas (só no cupom impresso), QR Code por mesa (cliente só pede se a mesa já estiver aberta pelo garçom). Fechamento gera um novo status `SETTLED` (distinto de `DELIVERED`), com lançamento financeiro automático igual à entrega
  - Fidelidade: nova aba "Fidelidade" em Configurações (pontos, cashback ou compre-X-leve-Y); cashback é ganho automaticamente em todo pedido e pode ser resgatado como desconto no cardápio digital (mutuamente exclusivo com cupom); estornado automaticamente se o pedido for cancelado. Pontos são creditados e visíveis mas ainda sem botão de resgate; "compre X leve Y" é só um contador de referência por enquanto
  - Toggle "Aparece na Cozinha (KDS)" por produto (card em Produtos e no formulário) — itens sem preparo (bebidas, sobremesas prontas) não entram na fila da cozinha; um pedido só aparece no KDS se tiver pelo menos um item que precisa de preparo
- [ ] **Etapa 4 — Marketing** (campanhas WhatsApp para inativos/aniversariantes)
- [ ] **Etapa 7 — IA** (insights de margem, previsão de pico, detecção de inativos, geração de campanhas)
- [ ] **Etapa 8 — Vender o produto** (billing por assinatura — sem isso só dá pra operar a própria hamburgueria, não cobrar de outras)
- [ ] **Etapa 9 — Produção** (WebSocket para tempo real, testes automatizados)
