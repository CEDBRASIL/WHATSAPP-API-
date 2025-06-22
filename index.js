// multi-session WhatsApp disparador com Baileys, WebSocket, frontend, upload CSV

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const SESSIONS = ['chip1', 'chip2', 'chip3'];
const sockets = {};
const clients = {};
const numbers = {};
const sockInstances = {};
const uploads = multer({ dest: 'uploads/' });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

function normalizarNumero(numero) {
  let num = numero.replace(/\D/g, '');
  if (num.startsWith('55') && num.length === 13 && num[4] === '9') {
    num = '55' + num.slice(5);
  } else if (num.length === 11 && num.startsWith('9')) {
    num = '5561' + num.slice(1);
  } else if (num.length === 10 || num.length === 11) {
    num = '55' + num;
  }
  return num;
}

async function iniciarSessao(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`auth/${sessionId}`);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sockInstances[sessionId] = sock;

  numbers[sessionId] = [];

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      const qrBase64 = await qrcode.toDataURL(qr);
      sockets[sessionId]?.emit('qr', qrBase64);
    }
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) iniciarSessao(sessionId);
    }
  });
}

SESSIONS.forEach(iniciarSessao);

app.get('/qr', (req, res) => {
  const session = req.query.session;
  if (!session || !SESSIONS.includes(session)) {
    return res.status(400).send('Sessão inválida');
  }
  res.send(`<html><body><script>
    const socket = io();
    socket.emit('join', '${session}');
    socket.on('qr', qr => {
      document.body.innerHTML = '<img src="' + qr + '">';
    });
  </script></body></html>`);
});

app.post('/upload', uploads.single('file'), (req, res) => {
  const session = req.query.session;
  if (!session || !SESSIONS.includes(session)) {
    return res.status(400).send('Sessão inválida');
  }
  const file = req.file;
  const content = fs.readFileSync(file.path);
  const records = parse(content, { columns: true, skip_empty_lines: true });
  numbers[session] = records.map(r => normalizarNumero(r.numero || r.number));
  fs.unlinkSync(file.path);
  res.send('Números carregados com sucesso');
});

app.post('/disparos', async (req, res) => {
  const session = req.query.session;
  const { numeros, mensagens } = req.body;

  if (!session || !SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  if (!mensagens || !Array.isArray(mensagens) || mensagens.length === 0) return res.status(400).send('Mensagens obrigatórias');
  if (!numeros || numeros.length === 0) return res.status(400).send('Números obrigatórios');
  if (numeros.length > 600) return res.status(400).send('O limite é 600 números');

  const sock = sockInstances[session];
  if (!sock) return res.status(500).send('Sessão não iniciada');

  res.send('Disparo iniciado');

  for (let i = 0; i < numeros.length; i++) {
    const numero = normalizarNumero(numeros[i]);
    const mensagem = mensagens[Math.floor(Math.random() * mensagens.length)];
    try {
      await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: mensagem });
      clients[session]?.emit('status', { numero, mensagem, status: 'enviado', index: i });
    } catch (e) {
      clients[session]?.emit('status', { numero, mensagem, status: 'erro', erro: e.message });
    }
    const delay = Math.floor(Math.random() * (125 - 60 + 1) + 60) * 1000;
    await new Promise(r => setTimeout(r, delay));
  }
});

io.on('connection', socket => {
  socket.on('join', session => {
    if (SESSIONS.includes(session)) {
      sockets[session] = socket;
      clients[session] = socket;
    }
  });
});

server.listen(3000, () => console.log('Servidor iniciado na porta 3000'));
