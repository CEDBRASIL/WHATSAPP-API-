// index.js (com verificação de sessão ativa antes de cada disparo)

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const xlsx = require('xlsx');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeBase64 = null;
const upload = multer({ dest: 'uploads/' });

app.use(express.json());

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function corrigirNumero(numero) {
  if (numero.startsWith('55') && numero.length === 13 && numero[4] === '9') {
    return numero.slice(0, 4) + numero.slice(5);
  }
  return numero;
}

app.get('/', (_, res) => res.send('Bot rodando'));

app.get('/status', (_, res) => res.json({ conectado: !!(sock && sock.user) }));

app.post('/connect', (_, res) => {
  if (sock && sock.user) return res.send('Já conectado');
  startBot();
  res.send('Iniciando conexão');
});

app.get('/connect', (_, res) => {
  if (qrCodeBase64) return res.send(`<html><body><img src="${qrCodeBase64}" alt="QR Code" /></body></html>`);
  res.send('Conectado com sucesso');
});

app.get('/qr', (_, res) => {
  if (qrCodeBase64) return res.send(`<html><body><img src="${qrCodeBase64}" alt="QR Code" /></body></html>`);
  res.status(404).send('QR Code não disponível.');
});

app.post('/disparo', async (req, res) => {
  const { mensagens, numeros } = req.body;

  if (!Array.isArray(mensagens) || mensagens.length === 0)
    return res.status(400).send('Envie um array com mensagens');
  if (!Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).send('Envie um array com números');
  if (!sock) return res.status(500).send('Bot não iniciado');

  let lista = numeros.slice(0, 600).map(corrigirNumero).sort(() => 0.5 - Math.random());
  const tempoEstimadoTotal = lista.length * 97000;
  const previsaoFinal = new Date(Date.now() + tempoEstimadoTotal);

  broadcast({ event: 'inicio', total: lista.length, previsao_fim: previsaoFinal.toLocaleTimeString() });

  (async () => {
    for (let i = 0; i < lista.length; i++) {
      if (!sock || !sock.user) {
        broadcast({ event: 'erro', message: '🔌 Desconectado do WhatsApp. Disparo cancelado.' });
        break;
      }

      const numero = lista[i];
      const jid = `${numero}@s.whatsapp.net`;
      const agora = new Date();
      const hora = agora.getHours();

      if (hora < 7 || hora >= 22) {
        broadcast({ event: 'pausa', message: '⏸ Fora do horário. Aguardando 15min...' });
        await new Promise(r => setTimeout(r, 15 * 60 * 1000));
        i--;
        continue;
      }

      try {
        const chats = await sock.chatRead(jid);
        if (!chats?.messages?.length) {
          broadcast({ event: 'pulado', numero });
          continue;
        }
      } catch (err) {
        broadcast({ event: 'erro', numero, error: err.message });
      }

      const msg = mensagens[Math.floor(Math.random() * mensagens.length)];

      try {
        await sock.presenceSubscribe(jid);
        await new Promise(r => setTimeout(r, 2000));

        const presencas = ['composing', 'recording', 'available'];
        const presence = presencas[Math.floor(Math.random() * presencas.length)];
        await sock.sendPresenceUpdate(presence, jid);

        const typingTime = 2000 + Math.floor(Math.random() * 4000);
        await new Promise(r => setTimeout(r, typingTime));

        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text: msg });

        const progresso = Math.round(((i + 1) / lista.length) * 100);
        broadcast({ event: 'enviado', numero, mensagem: msg, progresso, estimado_fim: previsaoFinal.toLocaleTimeString() });
      } catch (err) {
        broadcast({ event: 'erro', numero, error: err.message });
      }

      const delay = 60000 + Math.floor(Math.random() * 65000);
      await new Promise(r => setTimeout(r, delay));

      if ((i + 1) % 40 === 0) {
        broadcast({ event: 'pausa', message: '⏸ Pausa de 15 minutos após 40 envios...' });
        await new Promise(r => setTimeout(r, 15 * 60 * 1000));
      }
    }

    broadcast({ event: 'concluido', total: lista.length });
  })();

  res.send(`Disparo iniciado para até ${lista.length} números`);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrCodeBase64 = await qrcode.toDataURL(qr);
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        (lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut);
      if (shouldReconnect) {
        console.log('Tentando reconectar...');
        startBot();
      }
    } else if (connection === 'open') {
      qrCodeBase64 = null;
      console.log('Conectado ao WhatsApp');
    }
  });
}

startBot();

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
