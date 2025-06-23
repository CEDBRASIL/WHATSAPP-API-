// WhatsApp Disparador – multi‑session (Baileys) com pausa/continuação, countdown exato e CORS
// -----------------------------------------------------------------------------
// Endpoints:
//  POST /disparos?session=chipX      – inicia fila
//  POST /pausar?session=chipX        – pausa envio
//  POST /continuar?session=chipX     – continua envio
//  GET  /status?session=chipX        – status conectado
//  GET  /:session/grupos             – lista grupos
//  GET  /:session/grupo/:id/membros  – lista membros
//  GET  /qr?session=chipX            – QR Code ou "conectado"

const express  = require('express');
const http     = require('http');
const fs       = require('fs');
const multer   = require('multer');
const { parse }= require('csv-parse/sync');
const { Server }= require('socket.io');
const cors      = require('cors');
const qrcode    = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

// ─────────────────────────────────────────────────────────────────────────────
const SESSIONS = ['chip1', 'chip2', 'chip3'];
const uploads  = multer({ dest: 'uploads/' });

const sockets       = {}; // socket.io por sessão
const clients       = {}; // referência front‑end
const sockInstances = {}; // conexões Baileys
const sessionQueues = {}; // controle de filas
const lastQRCodes   = {}; // último QR Code por sessão

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────── Funções utilitárias ────────────────────────────
function normalizarNumero(numero = '') {
  let num = numero.toString().replace(/\D/g, '');
  if (num.startsWith('55') && num.length === 13 && num[4] === '9') num = '55' + num.slice(5);
  else if (num.length === 11 && num.startsWith('9')) num = '5561' + num.slice(1);
  else if (num.length === 10 || num.length === 11) num = '55' + num;
  return num;
}
function randomDelayMs() {
  return Math.floor(Math.random() * (125 - 60 + 1) + 60) * 1000; // 60‑125 s
}

// ───────────────────────────── Processamento da fila ─────────────────────────
async function processQueue(session) {
  const ctrl = sessionQueues[session];
  if (!ctrl || ctrl.paused || !ctrl.running) return;
  if (ctrl.index >= ctrl.numeros.length) { ctrl.running = false; return; }

  const num  = normalizarNumero(ctrl.numeros[ctrl.index]);
  const msg  = ctrl.mensagens[Math.floor(Math.random() * ctrl.mensagens.length)];
  const wait = randomDelayMs();
  const sock = sockInstances[session];

  try {
    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: msg });
    clients[session]?.emit('status', { numero: num, mensagem: msg, status: 'enviado', index: ctrl.index, nextDelay: wait / 1000 });
  } catch (e) {
    clients[session]?.emit('status', { numero: num, mensagem: msg, status: 'erro', erro: e.message, index: ctrl.index, nextDelay: wait / 1000 });
  }

  ctrl.index += 1;
  if (ctrl.index < ctrl.numeros.length) setTimeout(() => processQueue(session), wait);
  else ctrl.running = false;
}

// ─────────────────────────── Inicialização de sessões ───────────────────────
async function iniciarSessao(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`auth/${sessionId}`);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sockInstances[sessionId] = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;
    if (qr) {
      const qrDataUrl = await qrcode.toDataURL(qr);
      lastQRCodes[sessionId] = qrDataUrl;
      sockets[sessionId]?.emit('qr', qrDataUrl);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) iniciarSessao(sessionId);
    }
    if (connection === 'open') {
      sockets[sessionId]?.emit('conectado');
      sockInstances[sessionId].conectado = true;
      lastQRCodes[sessionId] = null;
    }
  });
}
SESSIONS.forEach(iniciarSessao);

// ─────────────────────────── Rotas de controle ──────────────────────────────
app.get('/status', (req, res) => {
  const { session } = req.query;
  if (!SESSIONS.includes(session)) return res.status(400).json({ erro: 'Sessão inválida' });
  res.json({ session, conectado: !!sockInstances[session]?.conectado });
});
app.post('/pausar', (req, res) => {
  const { session } = req.query; const c = sessionQueues[session];
  if (!c) return res.status(400).json({ erro: 'Nenhuma fila em execução' });
  c.paused = true; return res.json({ session, pausado: true, index: c.index });
});
app.post('/continuar', (req, res) => {
  const { session } = req.query; const c = sessionQueues[session];
  if (!c) return res.status(400).json({ erro: 'Nenhuma fila carregada' });
  c.paused = false; if (!c.running) { c.running = true; processQueue(session); }
  return res.json({ session, pausado: false, index: c.index });
});

// ─────────────────────────── Disparos ───────────────────────────────────────
app.post('/disparos', (req, res) => {
  const { session } = req.query;
  const { numeros, mensagens } = req.body;
  if (!SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  if (!mensagens?.length) return res.status(400).send('Mensagens obrigatórias');
  if (!numeros?.length) return res.status(400).send('Números obrigatórios');
  if (numeros.length > 600) return res.status(400).send('O limite é 600 números');
  if (!sockInstances[session]) return res.status(500).send('Sessão não iniciada');

  sessionQueues[session] = { numeros, mensagens, index: 0, paused: false, running: true };
  res.send('Disparo iniciado');
  processQueue(session);
});

// ─────────────────────────── Grupos / membros ──────────────────────────────
app.get('/:session/grupos', async (req, res) => {
  const { session } = req.params; if (!SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  const sock = sockInstances[session]; if (!sock) return res.status(500).send('Sessão não iniciada');
  try {
    const chats = await sock.chats.all();
    const grupos = chats.filter(c => c.id.endsWith('@g.us')).map(c => ({ id: c.id, nome: c.name }));
    res.json({ chip: session, total: grupos.length, grupos });
  } catch (e) { res.status(500).json({ erro: 'Erro ao listar grupos', detalhe: e.message }); }
});
app.get('/:session/grupo/:id/membros', async (req, res) => {
  const { session, id } = req.params; if (!SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  const sock = sockInstances[session]; if (!sock) return res.status(500).send('Sessão não iniciada');
  try {
    const meta = await sock.groupMetadata(id + '@g.us');
    res.json({ chip: session, grupo: meta.subject, quantidade: meta.participants.length, membros: meta.participants.map(p => p.id) });
  } catch (e) { res.status(500).json({ erro: 'Erro ao obter membros', detalhe: e.message }); }
});

// ─────────────────────────── QR Code ────────────────────────────────────────
app.get('/qr', (req, res) => {
  const { session } = req.query;
  if (!SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  const sock = sockInstances[session];
  if (sock?.conectado) {
    return res.status(200).send(`<!DOCTYPE html><html><body style=\"background:#000;color:#0f0;display:flex;align-items:center;justify-content:center;height:100vh\"><h1>${session.toUpperCase()} conectado</h1></body></html>`);
  }
  if (lastQRCodes[session]) {
    return res.status(200).send(`<!DOCTYPE html><html><body style=\"background:#000;display:flex;align-items:center;justify-content:center;height:100vh\"><img src='${lastQRCodes[session]}' alt='QR Code'></body></html>`);
  }
  res.status(503).send('QR Code não disponível. Aguarde a inicialização da sessão.');
});

// ─────────────────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
