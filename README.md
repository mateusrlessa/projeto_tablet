# HubSync - Painel Tablets TI

Aplicação full-stack para monitoramento de tablets com interface em Vite, API em Express e banco Postgres no Docker.

## Funcionalidades

- Dashboard com totais de monitoramento
- Lista de ativos com busca
- Cadastro de novo ativo
- Login e cadastro de usuários
- Confirmação de e-mail no cadastro
- Recuperação de senha (esqueci minha senha)
- Renovação individual e em lote dos vencidos
- Envio de renovação por e-mail com destinatário salvo no ativo
- Notificações automáticas por e-mail (novo ativo, próximo do vencimento e vencido)
- Preferências de notificação por usuário
- Auditoria de exclusão de usuários
- Hardening de segurança (Helmet, Rate Limit e CORS restrito em produção)
- Exportação em XLSX
- Banco de dados em Docker via PostgreSQL

## Requisitos

- Node.js 20+
- Docker e Docker Compose

## Como executar localmente

1. Crie o arquivo `.env` com base em `.env.example`.
	Para envio real de e-mail, preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`.
	Para link de redefinição de senha, defina também `FRONTEND_URL` (exemplo: `http://localhost:5173`).
	Para produção, configure também `AUTH_SECRET` forte e `CORS_ALLOWED_ORIGINS`.
2. Instale dependências:

```bash
npm install
```

3. Suba o banco:

```bash
docker compose up -d db
```

4. Inicialize a estrutura e os dados iniciais:

```bash
npm run db:init
```

Se você já tinha banco criado antes, rode novamente o comando acima para aplicar as novas colunas e tabelas.

5. Inicie a aplicação:

```bash
npm run dev
```

A interface fica em `http://localhost:5173` e a API em `http://localhost:3002`.
O Postgres fica exposto em `localhost:5433`.

## Observações importantes

- A contagem de vencimento fica persistida no banco e é calculada no backend.
- O login exige e-mail confirmado para contas de auto-cadastro.
- Senha mínima de segurança: 10 caracteres com maiúscula, minúscula, número e símbolo.
- Se SMTP não estiver configurado, tokens de redefinição e confirmação são retornados em resposta da API apenas para desenvolvimento local.
- Fechar o navegador não perde dados, mas se o computador for desligado os serviços locais param.
- Para manter tudo ativo 24/7, rode em um servidor sempre ligado (VPS, cloud ou máquina dedicada).

### Acesso inicial

- E-mail: `admin@hubsync.local`
- Senha: `123456`

## Como executar com Docker

```bash
docker compose up --build
```

A aplicação sobe em `http://localhost:3002`.

## Deploy e Produção

- Guia 24/7: [DEPLOY_24_7_GUIDE.md](DEPLOY_24_7_GUIDE.md)
