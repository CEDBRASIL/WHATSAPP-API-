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

const app = express();
const PORT = process.env.PORT || 3000;
let sock = null;
let qrCodeBase64 = null;
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

function getAllFiles(dir, base = dir) {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, getAllFiles(full, base));
    } else {
      try {
        const rel = path.relative(base, full);
        result[rel] = fs.readFileSync(full, 'utf8');
      } catch (err) {
        result[rel] = '[binary]';
      }
    }
  }
  return result;
}



app.use(express.json());
loadNumbers();

app.get('/', (_, res) => {
  res.send('Bot rodando');
});

app.get('/status', (_, res) => {
  res.json({ conectado: !!(sock && sock.user) });
});

app.post('/connect', (_, res) => {
  if (sock && sock.user) {
    return res.send('Já conectado');
  }
  startBot();
  res.send('Iniciando conexão');
});

app.get('/connect', (_, res) => {
  if (qrCodeBase64) {
    return res.send(
      `<html><body><img src="${qrCodeBase64}" alt="QR Code" /></body></html>`
    );
  }
  res.send('Conectado com sucesso');
});

app.get('/numbers', (_, res) => {
  res.json(numbers);
});

app.get('/info', (_, res) => {
  const data = getAllFiles(__dirname);
  res.json(data);
});

// Lista todos os grupos que o bot participa
app.get('/grupos', async (_, res) => {
  if (!sock) return res.status(500).send('Bot não iniciado');
  try {
    const grupos = await sock.groupFetchAllParticipating();
    const lista = Object.values(grupos).map(g => ({ id: g.id, nome: g.subject }));
    res.json(lista);
  } catch (err) {
    console.error('Erro ao listar grupos:', err);
    res.status(500).send('Erro ao listar grupos');
  }
});

// Mostra os integrantes de um grupo específico
app.get('/grupos/:nome', async (req, res) => {
  if (!sock) return res.status(500).send('Bot não iniciado');
  const nome = req.params.nome.toLowerCase();
  try {
    const grupos = await sock.groupFetchAllParticipating();
    const grupo = Object.values(grupos).find(g => g.subject.toLowerCase() === nome);
    if (!grupo) return res.status(404).send('Grupo não encontrado');
    const meta = await sock.groupMetadata(grupo.id);
    const participantes = meta.participants.map(p => ({
      numero: p.id.split('@')[0],
      admin: !!p.admin
    }));
    res.json({ id: meta.id, nome: meta.subject, participantes });
  } catch (err) {
    console.error('Erro ao obter informações do grupo:', err);
    res.status(500).send('Erro ao obter informações do grupo');
  }
});

app.post('/add-number', (req, res) => {
  const numero = req.body.numero;
  if (!numero) return res.status(400).send('Número é obrigatório');
  if (!numbers.includes(numero)) {
    numbers.push(numero);
    saveNumbers();
  }
  res.send('Número adicionado');
});

app.post('/upload-numbers', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('Arquivo é obrigatório');
  try {
    if (file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
      const workbook = xlsx.readFile(file.path);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(sheet);
      data.forEach(r => {
        const n = r.numero || r.number;
        if (n && !numbers.includes(String(n))) numbers.push(String(n));
      });
    } else if (file.originalname.endsWith('.csv')) {
      const content = fs.readFileSync(file.path);
      const records = parse(content, { columns: true, skip_empty_lines: true });
      records.forEach(r => {
        const n = r.numero || r.number;
        if (n && !numbers.includes(String(n))) numbers.push(String(n));
      });
    } else {
      fs.unlinkSync(file.path);
      return res.status(400).send('Formato não suportado');
    }
    saveNumbers();
    fs.unlinkSync(file.path);
    res.send('Números adicionados');
  } catch (err) {
    console.error('Erro ao processar arquivo:', err);
    res.status(500).send('Erro ao processar arquivo');
  }
});

app.post('/disparo', async (req, res) => {
  const { mensagem, intervalo } = req.body;
  if (!mensagem) return res.status(400).send('Mensagem é obrigatória');
  if (!sock) return res.status(500).send('Bot não iniciado');
  const delay = parseInt(intervalo || 1000);
  (async () => {
    for (const num of numbers) {
      try {
        await sock.sendMessage(`${num}@s.whatsapp.net`, { text: mensagem });
        await new Promise(r => setTimeout(r, delay));
      } catch (e) {
        console.error('Erro ao enviar para', num, e);
      }
    }
  })();
  res.send('Disparo iniciado');
});

app.get('/qr', (_, res) => {
  if (qrCodeBase64) {
    res.send(`<html><body><img src="${qrCodeBase64}" alt="QR Code" /></body></html>`);
  } else {
    res.status(404).send('QR Code não disponível.');
  }
});

app.get('/send', async (req, res) => {
  const para = req.query.para;
  const mensagem = req.query.mensagem;
  if (!para || !mensagem) {
    return res.status(400).send('Parâmetros "para" e "mensagem" são obrigatórios.');
  }
  if (!sock) return res.status(500).send('Bot não iniciado');
  try {
    await sock.sendMessage(`${para}@s.whatsapp.net`, { text: mensagem });
    res.send('Mensagem enviada');
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).send('Erro ao enviar mensagem');
  }
});

// Endpoint para verificações via método HEAD
app.head('/secure', (_, res) => {
  res.status(200).end();
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeBase64 = await qrcode.toDataURL(qr);
    }
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
