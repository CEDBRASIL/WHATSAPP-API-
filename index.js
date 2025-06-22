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
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

let sock = null;
let isReady = false;
let qrCodeBase64 = null;
let disparoFila = [];
let emDisparo = false;
const NUMBERS_FILE = 'numbers.json';
let numbers = [];
const upload = multer({ dest: 'uploads/' });

function loadNumbers() {
  if (fs.existsSync(NUMBERS_FILE)) {
    numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
  }
}

function saveNumbers() {
  fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
}

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

function sanitizeNumber(num) {
  if (num.startsWith('55') && num[4] === '9') {
    return num.slice(0, 4) + num.slice(5);
  }
  return num;
}

async function executarDisparo(numeros, mensagens) {
  if (emDisparo || !Array.isArray(numeros) || !Array.isArray(mensagens)) return;
  emDisparo = true;
  const delayMin = 60_000;
  const delayMax = 125_000;
  const total = numeros.length;
  const estimativa = new Date(Date.now() + ((delayMin + delayMax) / 2 * total));
  broadcast({ event: 'inicio', total, previsao_fim: estimativa.toLocaleTimeString() });

  for (let i = 0; i < total; i++) {
    const numeroOriginal = numeros[i];
    const numero = sanitizeNumber(numeroOriginal);
    const mensagem = mensagens[Math.floor(Math.random() * mensagens.length)];
    let enviado = false;

    while (!enviado) {
      if (sock && isReady) {
        try {
          await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: mensagem });
          enviado = true;
          broadcast({ event: 'enviado', numero, mensagem, progresso: Math.floor(((i + 1) / total) * 100) });
        } catch (err) {
          broadcast({ event: 'erro', numero, message: err.message });
          await new Promise(r => setTimeout(r, 5000));
        }
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
    broadcast({ event: 'pausa', message: `Aguardando ${Math.floor(delay / 1000)}s...` });
    await new Promise(r => setTimeout(r, delay));
  }

  broadcast({ event: 'concluido', total });
  emDisparo = false;
}

app.use(express.json());
loadNumbers();

app.get('/', (_, res) => {
  res.send('Bot rodando');
});

app.get('/status', (_, res) => {
  res.json({ conectado: !!(sock && sock.user), autorizado: isReady });
});

app.get('/connect', (_, res) => {
  if (qrCodeBase64) {
    return res.send(`<html><body><img src="${qrCodeBase64}" alt="QR Code" /></body></html>`);
  }
  res.send('Conectado com sucesso');
});

app.post('/disparos', async (req, res) => {
  const { numeros, mensagens } = req.body;
  if (!Array.isArray(numeros) || !Array.isArray(mensagens)) {
    return res.status(400).send('Formato inválido');
  }
  if (numeros.length > 600) {
    return res.status(400).send('O limite é 600 números');
  }
  disparoFila.push({ numeros, mensagens });
  if (!emDisparo) executarDisparo(numeros, mensagens);
  res.send('Disparo programado');
});

app.get('/painel', (_, res) => {
  res.sendFile(path.join(__dirname, 'painel.html'));
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrCodeBase64 = await qrcode.toDataURL(qr);

    if (connection === 'open') {
      qrCodeBase64 = null;
      isReady = true;
      console.log('✅ Conectado ao WhatsApp');
    }
    if (connection === 'close') {
      isReady = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('Tentando reconectar...');
        startBot();
      }
    }
  });
}

startBot();

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
