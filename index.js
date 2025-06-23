// WhatsApp Disparador – multi‑session (Baileys) 100 % funcional
// -----------------------------------------------------------------------------
// Endpoints principais
//  POST /disparos?session=chipX           – inicia fila (JSON { numeros, mensagens })
//  POST /pausar?session=chipX             – pausa envio
//  POST /continuar?session=chipX          – continua envio
//  POST /upload?session=chipX (CSV/XLSX)  – carrega números (coluna numero/number)
//  GET  /status?session=chipX             – status conectado
//  GET  /:session/grupos                  – lista grupos
//  GET  /:session/grupo/:id/membros       – lista membros
//  GET  /qr?session=chipX                 – QR Code ou "conectado"

const express   = require('express');
const http      = require('http');
const fs        = require('fs');
const multer    = require('multer');
const { parse } = require('csv-parse/sync');
const { Server } = require('socket.io');
const cors      = require('cors');
const qrcode    = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');

// ─────────────────────────────────────────────────────────────────────────────
const SESSIONS = ['chip1', 'chip2', 'chip3'];
const uploads  = multer({ dest: 'uploads/' });

const sockets       = {}; // socket.io por sessão
const clients       = {}; // referência front‑end para status/qr
const sockInstances = {}; // conexões Baileys
const sessionQueues = {}; // controle das filas
const lastQRCodes   = {}; // guarda último QR por sessão

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ───────────────────────── Funções utilitárias ──────────────────────────────
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

// ─────────────────────── Processamento da fila de disparos ──────────────────
async function processQueue(session) {
  const ctrl = sessionQueues[session];
  if (!ctrl || ctrl.paused || !ctrl.running) return;
  if (ctrl.index >= ctrl.numeros.length) { ctrl.running = false; return; }

  const numero   = normalizarNumero(ctrl.numeros[ctrl.index]);
  const mensagem = ctrl.mensagens[Math.floor(Math.random() * ctrl.mensagens.length)];
  const delayMs  = randomDelayMs();
  const sock     = sockInstances[session];

  try {
    await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: mensagem });
    clients[session]?.emit('status', { numero, mensagem, status: 'enviado', index: ctrl.index, nextDelay: delayMs / 1000 });
  } catch (e) {
    clients[session]?.emit('status', { numero, mensagem, status: 'erro', erro: e.message, index: ctrl.index, nextDelay: delayMs / 1000 });
  }

  ctrl.index += 1;
  if (ctrl.index < ctrl.numeros.length) setTimeout(() => processQueue(session), delayMs);
  else ctrl.running = false;
}

// ─────────────────────── Inicialização das sessões ─────────────────────────
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
      lastQRCodes[sessionId] = null; // limpa QR salvo
    }
  });
}
SESSIONS.forEach(iniciarSessao);

// ───────────────────── WebSocket: join e entrega de eventos ─────────────────
io.on('connection', socket => {
  socket.on('join', session => {
    if (SESSIONS.includes(session)) {
      sockets[session] = socket;
      clients[session] = socket;
      if (lastQRCodes[session]) socket.emit('qr', lastQRCodes[session]);
    }
  });
});

// ─────────────────────────── Rotas REST ─────────────────────────────────────
app.get('/status', (req, res) => {
  const { session } = req.query;
  if (!SESSIONS.includes(session)) return res.status(400).json({ erro: 'Sessão inválida' });
  res.json({ session, conectado: !!sockInstances[session]?.conectado });
});

app.post('/pausar', (req, res) => {
  const { session } = req.query;
  const c = sessionQueues[session];
  if (!c) return res.status(400).json({ erro: 'Nenhuma fila em execução' });
  c.paused = true;
  res.json({ session, pausado: true, index: c.index });
});

app.post('/continuar', (req, res) => {
  const { session } = req.query;
  const c = sessionQueues[session];
  if (!c) return res.status(400).json({ erro: 'Nenhuma fila carregada' });
  c.paused = false;
  if (!c.running) { c.running = true; processQueue(session); }
  res.json({ session, pausado: false, index: c.index });
});

app.post('/upload', uploads.single('file'), (req, res) => {
  const { session } = req.query;
  if (!SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  const buf = fs.readFileSync(req.file.path);
  const rows = parse(buf, { columns: true, skip_empty_lines: true });
  const numeros = rows.map(r => normalizarNumero(r.numero || r.number));
  sessionQueues[session] = sessionQueues[session] || { numeros: [], mensagens: [], index: 0, paused: false, running: false };
  sessionQueues[session].numeros = numeros;
  fs.unlinkSync(req.file.path);
  res.send('Números carregados');
});

app.post('/disparos', (req, res) => {
  const { session } = req.query;
  const { numeros, mensagens } = req.body;
  if (!SESSIONS.includes(session)) return res.status(400).send('Sessão inválida');
  if (!mensagens?.length) return res.status(400).send('Mensagens obrigatórias');
  if (!numeros?.length) return res.status(400).send('Números obrigatórios');
  if (numeros.length > 600) return res.status(400).send('O limite é 600 números');
  if (!sockInstances[session]) return res.status(500).send('Sessão não iniciada');

  sessionQueues[session] = { numeros, mensagens, index: 0
