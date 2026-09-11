// RSPro — server kecil tanpa dependensi.
// 1) Menyajikan folder "kofi/" sebagai situs statis.
// 2) Menyediakan tombol "Update dari Git" (POST /api/update menjalankan git pull).
//
// Cara pakai di VPS (butuh Node.js & git terpasang):
//   git clone https://github.com/RSPro96/kofi.git /var/www/kofi
//   cd /var/www/kofi && node server.js
//   (opsional) PORT=8080 node server.js  atau  pm2 start server.js --name rspro
//
// Endpoint:
//   GET  /api/version        -> versi lokal saat ini (tanpa akses jaringan)
//   GET  /api/update/status  -> cek apakah ada versi lebih baru di origin
//   POST /api/update         -> jalankan git pull --ff-only
//
// Pembaruan otomatis: server memeriksa GitHub sendiri tiap AUTO_UPDATE_MIN
// menit (bawaan 5) dan menarik versi baru dengan git pull --ff-only. Halaman
// yang sedang terbuka mendeteksi versinya berubah lewat /api/version dan
// memuat ulang sendiri begitu aman. AUTO_UPDATE_MIN=0 mematikannya.
// --ff-only tidak pernah menimpa perubahan lokal: kalau ada bentrok, pull
// ditolak dan server tetap jalan dengan versi yang ada.

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;                        // akar repo (tempat server.js berada)
const PUBLIC = path.join(ROOT, "kofi");        // folder situs yang disajikan
const PORT = parseInt(process.env.PORT, 10) || 8080;
const BRANCH = process.env.BRANCH || "master";
const AUTO_MIN = process.env.AUTO_UPDATE_MIN === undefined ? 5 : (parseFloat(process.env.AUTO_UPDATE_MIN) || 0);
const auto = { aktif: AUTO_MIN > 0, tiapMenit: AUTO_MIN, terakhirCek: null, hasil: null };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8"
};

function run(args, opts) {
  return new Promise(function (resolve) {
    execFile("git", args, Object.assign({ cwd: ROOT, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, opts || {}), function (err, stdout, stderr) {
      resolve({ err: err || null, out: String(stdout || "").trim(), errOut: String(stderr || "").trim() });
    });
  });
}

async function gitVersion() {
  const head = await run(["rev-parse", "--short", "HEAD"]);
  return { local: head.err ? null : head.out, branch: BRANCH, auto: auto };
}

async function gitStatus() {
  const v = await gitVersion();
  const fetchR = await run(["fetch", "origin"]);
  if (fetchR.err) return { error: fetchR.errOut || fetchR.err.message || "git fetch gagal", branch: BRANCH, local: v.local };
  const local = await run(["rev-parse", "HEAD"]);
  const remote = await run(["rev-parse", "origin/" + BRANCH]);
  if (remote.err) return { error: "Branch '" + BRANCH + "' tidak ditemukan di origin.", branch: BRANCH, local: v.local };
  const behindR = await run(["rev-list", "--count", "HEAD..origin/" + BRANCH]);
  const behind = parseInt(behindR.out || "0", 10);
  return {
    upToDate: local.out.trim() === remote.out.trim(),
    behind: isFinite(behind) ? behind : 0,
    local: v.local,
    remote: remote.out.trim().slice(0, 7),
    branch: BRANCH
  };
}

// fetch/pull tidak boleh jalan bersamaan (tombol manual vs pemeriksaan otomatis)
let sibuk = false;
async function kunci(fn, kalauSibuk) {
  if (sibuk) return kalauSibuk;
  sibuk = true;
  try { return await fn(); } finally { sibuk = false; }
}

async function gitPull() {
  const sebelum = (await run(["rev-parse", "HEAD"])).out;
  const r = await run(["pull", "--ff-only", "origin", BRANCH]);
  const hasil = { ok: !r.err, output: (r.out + (r.errOut ? "\n" + r.errOut : "")).trim() };
  if (hasil.ok) {
    const sesudah = (await run(["rev-parse", "HEAD"])).out;
    if (sesudah && sesudah !== sebelum) {
      console.log("[update] " + sebelum.slice(0, 7) + " -> " + sesudah.slice(0, 7));
      const berubah = (await run(["diff", "--name-only", sebelum, sesudah])).out.split("\n");
      // halaman dibaca ulang dari disk tiap permintaan, tapi server.js sendiri
      // baru berlaku setelah prosesnya dijalankan ulang
      if (berubah.indexOf("server.js") >= 0) {
        if (process.env.pm_id !== undefined) {
          console.log("[update] server.js berubah — keluar supaya pm2 menjalankannya ulang");
          setTimeout(function () { process.exit(0); }, 1000);
        } else {
          console.log("[update] server.js berubah — jalankan ulang server supaya perubahannya aktif");
        }
      }
    }
  }
  return hasil;
}

async function periksaOtomatis() {
  await kunci(async function () {
    auto.terakhirCek = new Date().toISOString();
    const st = await gitStatus();
    if (st.error) { auto.hasil = "gagal memeriksa: " + st.error; console.log("[auto-update] " + auto.hasil); return; }
    if (!st.behind) { auto.hasil = "sudah versi terbaru"; return; }
    const p = await gitPull();
    auto.hasil = p.ok ? "diperbarui otomatis" : "gagal menarik: " + p.output.slice(0, 200);
    if (!p.ok) console.log("[auto-update] " + auto.hasil);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const fp = path.resolve(PUBLIC, "." + rel);
  const base = path.resolve(PUBLIC);
  if (fp !== base && !fp.startsWith(base + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404); res.end("404 Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

http.createServer(function (req, res) {
  const p = new URL(req.url, "http://localhost").pathname;

  if (p === "/api/version") { gitVersion().then(function (d) { sendJson(res, 200, d); }); return; }
  if (p === "/api/update/status") {
    kunci(gitStatus, { busy: true }).then(function (d) { sendJson(res, 200, d); }); return;
  }
  if (p === "/api/update" && req.method === "POST") {
    kunci(gitPull, { ok: false, busy: true, output: "Server sedang memeriksa pembaruan, coba lagi sebentar." })
      .then(function (d) { sendJson(res, d.ok ? 200 : (d.busy ? 409 : 500), d); }); return;
  }

  serveStatic(res, p);
}).listen(PORT, "0.0.0.0", function () {
  console.log("RSPro server jalan di http://0.0.0.0:" + PORT);
  console.log("Folder situs : " + PUBLIC);
  console.log("Repo git     : " + ROOT + " (branch " + BRANCH + ")");
  console.log("Update dari Git aktif: POST /api/update");
  console.log(auto.aktif ? "Pembaruan otomatis: tiap " + AUTO_MIN + " menit (AUTO_UPDATE_MIN=0 untuk mematikan)"
                         : "Pembaruan otomatis: mati");
});

if (auto.aktif) {
  setTimeout(periksaOtomatis, 15000);              // beri waktu server siap dulu
  setInterval(periksaOtomatis, AUTO_MIN * 60000);
}