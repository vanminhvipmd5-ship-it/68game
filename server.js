const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const FIREBASE = "https://gb-8e4c1-default-rtdb.firebaseio.com/taixiu_sessions/current.json";
const MONGO = "mongodb://127.0.0.1:27017/taixiu";

// =========================
// CONNECT DB
// =========================
mongoose.connect(MONGO);

const Session = mongoose.model("Session", new mongoose.Schema({
  phien: Number,
  xuc_xac: [Number],
  tong: Number,
  ket_qua: String,
  createdAt: { type: Date, default: Date.now }
}));

// =========================
// TOKEN
// =========================
const token = (p) => "VM-" + p + "-" + Date.now().toString(36);

// =========================
// MARKOV BẬC 2 + WEIGHT
// =========================
async function markov2() {
  const data = await Session.find().sort({ createdAt: -1 }).limit(30);
  if (data.length < 6) return { du_doan: "Không đủ dữ liệu", ti_le: "0%" };

  let map = {};

  for (let i = 0; i < data.length - 2; i++) {
    let key = data[i].ket_qua + "-" + data[i + 1].ket_qua;
    let next = data[i + 2].ket_qua;

    if (!map[key]) map[key] = { "Tài": 0, "Xỉu": 0 };

    // weighting: gần hiện tại = trọng số cao
    let weight = data.length - i;
    map[key][next] += weight;
  }

  let currentKey = data[0].ket_qua + "-" + data[1].ket_qua;
  let stat = map[currentKey];

  if (!stat) return { du_doan: "Không rõ", ti_le: "50%" };

  let predict = stat["Tài"] > stat["Xỉu"] ? "Tài" : "Xỉu";
  let total = stat["Tài"] + stat["Xỉu"];

  return {
    du_doan: predict,
    ti_le: ((Math.max(stat["Tài"], stat["Xỉu"]) / total) * 100).toFixed(2) + "%",
    cau: currentKey
  };
}

// =========================
// PHÁT HIỆN CẦU
// =========================
async function detectCau() {
  const data = await Session.find().sort({ createdAt: -1 }).limit(10);
  let seq = data.map(x => x.ket_qua);

  // bệt (lặp)
  if (seq.every(x => x === seq[0])) {
    return "Cầu bệt " + seq[0];
  }

  // đảo
  let dao = true;
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i] === seq[i + 1]) dao = false;
  }
  if (dao) return "Cầu đảo";

  // gãy (đổi hướng)
  if (seq[0] !== seq[1] && seq[1] === seq[2]) {
    return "Cầu gãy";
  }

  return "Không rõ";
}

// =========================
// REALTIME CLIENTS (SSE)
// =========================
let clients = [];

// =========================
// SYNC DATA
// =========================
let lastPhien = null;

async function sync() {
  try {
    const res = await axios.get(FIREBASE);
    const d = res.data;

    if (!d || d.Phien === lastPhien) return;

    lastPhien = d.Phien;

    const newData = await Session.create({
      phien: d.Phien,
      xuc_xac: [d.xuc_xac_1, d.xuc_xac_2, d.xuc_xac_3],
      tong: d.tong,
      ket_qua: d.ket_qua
    });

    // giữ 50
    const count = await Session.countDocuments();
    if (count > 50) {
      const old = await Session.findOne().sort({ createdAt: 1 });
      await Session.deleteOne({ _id: old._id });
    }

    // AI
    const mk = await markov2();
    const cau = await detectCau();

    const payload = {
      phien: newData.phien,
      ket_qua: newData.ket_qua,
      tong: newData.tong,
      xuc_xac: newData.xuc_xac,

      du_doan: mk.du_doan,
      ti_le: mk.ti_le,
      cau: cau,

      token: token(newData.phien),
      chu_ky: "@vanminh2603"
    };

    // SSE push
    clients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));

    // WS push
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(payload));
      }
    });

    console.log("📡 Realtime:", payload);

  } catch (err) {
    console.log("❌ Sync lỗi:", err.message);
  }
}

setInterval(sync, 2000);

// =========================
// API JSON
// =========================
app.get("/taixiu", async (req, res) => {
  const last = await Session.findOne().sort({ createdAt: -1 });
  if (!last) return res.json({ status: "loading" });

  const mk = await markov2();
  const cau = await detectCau();

  res.json({
    phien: last.phien,
    ket_qua: last.ket_qua,
    tong: last.tong,
    xuc_xac: last.xuc_xac,

    du_doan: mk.du_doan,
    ti_le: mk.ti_le,
    cau: cau,

    token: token(last.phien),
    chu_ky: "@vanminh2603"
  });
});

// =========================
// SSE STREAM
// =========================
app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  res.flushHeaders();
  clients.push(res);

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

// =========================
// WS STREAM
// =========================
wss.on("connection", ws => {
  console.log("🔌 WS client connected");
});

// =========================
server.listen(PORT, () => {
  console.log("🚀 PRO MAX chạy:", PORT);
});
