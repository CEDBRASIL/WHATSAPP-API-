// disparador.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(bodyParser.json());

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

app.post("/disparos", (req, res) => {
  const { numbers = "", messages = [] } = req.body;
  const nums = numbers.split(",").map(n => n.trim()).filter(n => n);
  if (!nums.length || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Envie 'numbers' e 'messages' válidos" });
  }
  if (nums.length > 600) {
    return res.status(400).json({ error: "O limite é 600 números" });
  }

  const shuffledNums = nums.sort(() => 0.5 - Math.random());
  const shuffledMsgs = messages.sort(() => 0.5 - Math.random());
  const banChance = -0.01;

  (async () => {
    for (let i = 0; i < shuffledNums.length; i++) {
      const to = shuffledNums[i];
      const msg = shuffledMsgs[i % shuffledMsgs.length];
      const base = 50000, variance = Math.random() * 40000 - 20000;
      const delay = Math.max(30000, base + variance);
      await sleep(delay);

      const resultado = { to, message: msg, status: "sent" };
      broadcast({
        event: "disparo",
        progress: Math.round(((i + 1) / shuffledNums.length) * 100),
        banChance,
        data: resultado
      });
    }
    broadcast({ event: "done" });
  })();

  return res.json({ status: "iniciado", total: shuffledNums.length });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Disparador rodando em http://localhost:${PORT}`);
});
