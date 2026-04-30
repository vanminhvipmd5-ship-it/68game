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

// =========================
// DB (fallback RAM)
// =========================
let useMongo = false;
let history = [];

const MONGO = process.env.MONGO_URI || "";

if (MONGO) {
  mongoose.connect(MONGO)
    .then(() => {
      console.log("✅ Mongo OK");
      useMongo = true;
    })
    .catch(() => console.log("⚠️ Mongo lỗi → dùng RAM"));
}

const Session = mongoose.models.Session || mongoose.model("Session", new mongoose.Schema({
  phien: Number,
  xuc_xac: [Number],
  tong: Number,
  ket_qua: String,
  createdAt: { type: Date, default: Date.now }
}));

// =========================
// AI PRO (Markov + pattern + streak)
// =========================
function aiPro(data) {
  if (data.length < 10) {
    return { du_doan: "Không đủ dữ liệu", do_tin_cay: 0 };
  }

  let score = { Tài: 0, Xỉu: 0 };

  // Markov + weight
  for (let i = 0; i < data.length - 2; i++) {
    let next = data[i + 2].ket_qua;
    let weight = data.length - i;
    score[next] += weight * 1.5;
  }

  // streak (bệt)
  let streak = 1;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i].ket_qua === data[i + 1].ket_qua) streak++;
    else break;
  }

  if (streak >= 3) {
    score[data[0].ket_qua] += streak * 2;
  }

  // đảo
  let alternating = true;
  for (let i = 0; i < 6; i++) {
    if (data[i].ket_qua === data[i + 1].ket_qua) {
      alternating = false;
      break;
    }
  }

  if (alternating) {
    let next = data[0].ket_qua === "Tài" ? "Xỉu" : "Tài";
    score[next] += 8;
  }

  let predict = score.Tài > score.Xỉu ? "Tài" : "Xỉu";
  let total = score.Tài + score.Xỉu;

  let percent = total
    ? ((Math.max(score.Tài, score.Xỉu) / total) * 100).toFixed(2)
    : 50;

  return {
    du_doan: predict,
    do_tin_cay: percent
  };
}

// =========================
// CẦU
// =========================
function detectCau(data) {
  let seq = data.map(x => x.ket_qua);

  if (seq.every(x => x === seq[0])) return "Cầu bệt " + seq[0];

  let dao = true;
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i] === seq[i + 1]) dao = false;
  }
  if (dao) return "Cầu đảo";

  if (seq[0] !== seq[1] && seq[1] === seq[2]) return "Cầu gãy";

  return "Không rõ";
}

// =========================
// CẢNH BÁO
// =========================
function canhBao(p) {
  let v = parseFloat(p);
  if (v >= 70) return "VÀO MẠNH";
  if (v >= 60) return "CÓ THỂ VÀO";
  return "KHÔNG NÊN VÀO";
}

// =========================
// GET DATA
// =========================
async function getData() {
  if (useMongo) {
    return await Session.find().sort({ createdAt: -1 }).limit(50);
  }
  return history;
}

// =========================
// SYNC
// =========================
let lastPhien = null;
let clients = [];

async function sync() {
  try {
    const res = await axios.get(FIREBASE);
    const d = res.data;

    if (!d || d.Phien === lastPhien) return;

    lastPhien = d.Phien;

    const obj = {
      phien: d.Phien,
      xuc_xac: [d.xuc_xac_1, d.xuc_xac_2, d.xuc_xac_3],
      tong: d.tong,
      ket_qua: d.ket_qua
    };

    if (useMongo) {
      await Session.create(obj);
    } else {
      history.unshift(obj);
      if (history.length > 50) history.pop();
    }

    const data = await getData();
    const ai = aiPro(data);
    const cau = detectCau(data);

    const payload = {
      ...obj,
      du_doan: ai.du_doan,
      do_tin_cay: ai.do_tin_cay + "%",
      canh_bao: canhBao(ai.do_tin_cay),
      cau
    };

    // SSE
    clients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));

    // WS
    wss.clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    });

    console.log("📡", payload);

  } catch (e) {
    console.log("❌", e.message);
  }
}

setInterval(sync, 2000);

// =========================
// ROUTES
// =========================
app.get("/", (req, res) => {
  res.send("API Tài Xỉu AI đang chạy 🚀");
});

app.get("/taixiu", async (req, res) => {
  const data = await getData();
  if (!data.length) return res.json({ status: "loading" });

  const ai = aiPro(data);
  const cau = detectCau(data);
  const c = data[0];

  res.json({
    phien: c.phien,
    ket_qua: c.ket_qua,
    tong: c.tong,
    xuc_xac: c.xuc_xac,

    du_doan: ai.du_doan,
    do_tin_cay: ai.do_tin_cay + "%",
    canh_bao: canhBao(ai.do_tin_cay),

    cau
  });
});

// SSE
app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  res.flushHeaders();
  clients.push(res);

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

// WS
wss.on("connection", () => {
  console.log("🔌 WS connected");
});

// =========================
server.listen(PORT, () => {
  console.log("🚀 RUN PORT", PORT);
});
