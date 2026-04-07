# Deploy 24/7 com baixo custo (e sem licenca paga)

Este guia cobre uma estrategia de producao usando servicos gratuitos quando possivel.

## Objetivo

- Dominio proprio
- HTTPS valido
- API e frontend online
- Banco persistente com backup
- Monitoramento basico de uptime

## Observacao importante

Nenhum plano gratuito garante SLA de empresa. Para operacao realmente critica, use VPS pago com backup externo.

## Arquitetura recomendada (custo zero de licenca)

1. App e API em VM gratuita (Oracle Cloud Always Free)
2. PostgreSQL no mesmo host (ou separado, se possivel)
3. Nginx como reverse proxy
4. Cloudflare para DNS e camada de protecao
5. Certificado TLS via Let's Encrypt

## Checklist de preparacao

1. Trocar `AUTH_SECRET` por valor forte (>= 32 caracteres)
2. Definir `CORS_ALLOWED_ORIGINS` com seu dominio oficial
3. Configurar SMTP real para confirmacao/recuperacao de senha
4. Rodar `npm run build` e validar sem erros
5. Rodar `npm run db:init` no ambiente de producao
6. Remover credenciais padrao e trocar senha do admin inicial

## Variaveis obrigatorias de producao

- `NODE_ENV=production`
- `PORT=3001`
- `DATABASE_URL=postgres://...`
- `FRONTEND_URL=https://seu-dominio.com`
- `AUTH_SECRET=<seu-segredo-forte>`
- `CORS_ALLOWED_ORIGINS=https://seu-dominio.com`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

## Subida da aplicacao (resumo)

1. Clonar projeto na VM
2. Instalar Node.js 20+
3. Instalar dependencias: `npm install`
4. Build: `npm run build`
5. Inicializar DB: `npm run db:init`
6. Rodar app com PM2:
   - `npm install -g pm2`
   - `pm2 start npm --name hubsync -- start`
   - `pm2 save`
   - `pm2 startup`

## Nginx (reverse proxy)

- `https://seu-dominio.com` -> frontend/app
- `https://seu-dominio.com/api` -> API no mesmo processo

## HTTPS

1. Apontar DNS no Cloudflare para IP da VM
2. Gerar certificado com certbot (Let's Encrypt)
3. Forcar redirecionamento HTTP -> HTTPS

## Backup e restauracao

1. Backup diario com `pg_dump`
2. Manter historico de 7 a 14 dias
3. Testar restauracao ao menos 1x por mes

## Observabilidade minima

1. Uptime monitor gratuito (ex.: UptimeRobot)
2. Logs de aplicacao via PM2
3. Endpoint de saude: `/api/health`

## Hardening ja aplicado no projeto

- Helmet
- Rate limit global e em rotas de autenticacao
- CORS restrito em producao
- Validacao de e-mail
- Politica de senha forte
- Confirmacao de e-mail antes do login
- Auditoria de exclusao de usuario
- Notificacoes com deduplicacao
