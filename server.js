import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const PORT = Number(process.env.NOTIFY_API_PORT || 3005);

app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

app.post('/api/notificar-vencimento', async (req, res) => {
  try {
    const { nomeAtivo, numeroResponsavel, emailDestino, diasVencidos } = req.body;

    if (!nomeAtivo || !numeroResponsavel || !emailDestino || diasVencidos === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'Campos obrigatorios: nomeAtivo, numeroResponsavel, emailDestino e diasVencidos.',
      });
    }

    const dias = Number(diasVencidos);
    if (Number.isNaN(dias)) {
      return res.status(400).json({
        ok: false,
        error: 'diasVencidos deve ser um numero.',
      });
    }

    const assunto = `Alerta HubSync: tablet vencido - ${nomeAtivo}`;
    const html = `
      <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
        <h2 style="color: #dc2626; margin-bottom: 8px;">Notificacao de Manutencao Vencida</h2>
        <p>O ativo <strong>${nomeAtivo}</strong> ultrapassou o prazo de manutencao/sincronizacao.</p>
        <p><strong>Dias vencidos:</strong> ${dias}</p>
        <p><strong>Responsavel:</strong> ${numeroResponsavel}</p>
        <p>
          Acesse o painel HubSync para renovar o ativo e manter o monitoramento em conformidade.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
        <p style="font-size: 12px; color: #6b7280;">
          Esta e uma mensagem automatica do sistema HubSync.
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: emailDestino,
      subject: assunto,
      html,
    });

    return res.status(200).json({
      ok: true,
      message: 'Notificacao enviada com sucesso.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Falha ao enviar notificacao por e-mail.',
      details: error.message,
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, message: 'API de notificacao ativa.' });
});

app.listen(PORT, () => {
  console.log(`Servidor de notificacao rodando em http://localhost:${PORT}`);
});
