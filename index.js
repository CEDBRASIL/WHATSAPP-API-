// WhatsApp Disparador – multi‑session (Baileys) 100 % funcional
// -----------------------------------------------------------------------------
// Endpoints principais
//  POST /disparos?session=chipX           – inicia fila (JSON { numeros, mensagens })
//  POST /pausar?session=chipX             – pausa envio
//  POST /continuar?session=chipX          – continua envio
//  POST /upload?session=chipX (CSV/XLSX)  – carrega números (coluna numero/number)
//  GET  /status?session=chipX             – status conectado
//  GET  /:session/grupos                  – lista grupos
//  GET  /:session/grupo/:id/membros       – lista membros
//  GET  /qr?session=chipX                 – QR Code ou "conectado"

const express = require('express');
const http = require('http');
const fs = require('fs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { Server } = require('socket.io');
const cors = require('cors');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

// ─────────────────────────────────────────────────────────────────────────────
const SESSIONS = ['chip1', 'chip2', 'chip3'];
const uploads = multer({ dest: 'uploads/' });

const sockets = {}; // socket.io por sessão
const clients = {}; // referência front‑end para status/qr
const sockInstances = {}; // conexões Baileys
const sessionQueues = {}; // controle das filas
const lastQRCodes = {}; // guarda último QR por sessão

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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

  const numero = normalizarNumero(ctrl.numeros[ctrl.index]);
  const mensagem = ctrl.mensagens[Math.floor(Math.random() * ctrl.mensagens.length)];
  const delayMs = randomDelayMs();
  const sock = sockInstances[session];

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
      sockInstances[sessionId].conectado = false; // Adicionado para garantir o estado
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
          console.log(`Conexão fechada para ${sessionId}, reconectando... Razão: ${code}`);
          iniciarSessao(sessionId);
      } else {
          console.log(`Conexão fechada permanentemente para ${sessionId}. Limpando...`);
          // Limpar arquivos de autenticação se necessário
      }
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
      // Envia o status atual ao se conectar
      const isConnected = !!sockInstances[session]?.conectado;
      if (isConnected) {
          socket.emit('conectado');
      } else if (lastQRCodes[session]) {
          socket.emit('qr', lastQRCodes[session]);
      }
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

  sessionQueues[session] = { numeros, mensagens, index: 0, paused: false, running: true };
  processQueue(session);
  res.send('Disparo iniciado');
});

app.get('/:session/grupos', async (req, res) => {
    const session = req.params.session;
    if (!SESSIONS.includes(session)) {
        return res.status(400).send('Sessão inválida');
    }
    const sock = sockInstances[session];
    if (!sock) return res.status(500).send('Sessão não iniciada');

    try {
        const groupList = await sock.groupFetchAllParticipating();
        const grupos = Object.values(groupList).map(g => ({ id: g.id, nome: g.subject }));
        res.json({ chip: session, total: grupos.length, grupos });
    } catch (e) {
        res.status(500).json({ erro: 'Erro ao listar grupos', detalhe: e.message });
    }
});

app.get('/:session/grupo/:id/membros', async (req, res) => {
    const session = req.params.session;
    if (!SESSIONS.includes(session)) {
        return res.status(400).send('Sessão inválida');
    }
    const sock = sockInstances[session];
    if (!sock) return res.status(500).send('Sessão não iniciada');

    try {
        const groupId = req.params.id;
        const metadata = await sock.groupMetadata(groupId);
        const membros = metadata.participants.map(p => ({ id: p.id, admin: p.admin === 'admin' || p.admin === 'superadmin' }));
        res.json({ chip: session, grupo: metadata.subject, quantidade: membros.length, membros });
    } catch (e) {
        res.status(500).json({ erro: 'Erro ao obter membros', detalhe: e.message });
    }
});

app.get('/qr', (req, res) => {
    const session = req.query.session;
    if (!SESSIONS.includes(session)) {
        return res.status(400).send('Sessão inválida');
    }
    const sock = sockInstances[session];
    if (sock?.conectado) {
        return res.status(200).send(`<!DOCTYPE html><html><head><meta charset='UTF-8'><title>QR Code - ${session}</title></head><body style='background-color:#000; color:#0f0; display:flex; align-items:center; justify-content:center; height:100vh;'><h1>${session.toUpperCase()} já está conectado!</h1></body></html>`);
    }
    res.send(`
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>QR Code - ${session}</title>
        <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
      </head>
      <body style="background-color:#000; display:flex; justify-content:center; align-items:center; height:100vh;">
        <div id="qr-container" style="color:white;">Aguardando QR...</div>
        <script>
          const socket = io("${BASE_URL}");
          socket.emit('join', '${session}');
          socket.on('qr', qr => {
            document.getElementById('qr-container').innerHTML = '<img src="' + qr + '" />';
          });
          socket.on('conectado', () => {
            document.getElementById('qr-container').innerHTML = '<h2 style="color:white;">Conectado!</h2>';
          });
        </script>
      </body>
    </html>
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
