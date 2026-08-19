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

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;                        // akar repo (tempat server.js berada)
const PUBLIC = path.join(ROOT, "kofi");        // folder situs yang disajikan
const PORT = parseInt(process.env.PORT, 10) || 8080;
const BRANCH = process.env.BRANCH || "master";

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
  return { local: head.err ? null : head.out, branch: BRANCH };
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

async function gitPull() {
  const r = await run(["pull", "--ff-only", "origin", BRANCH]);
  return { ok: !r.err, output: (r.out + (r.errOut ? "\n" + r.errOut : "")).trim() };
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
  if (p === "/api/update/status") { gitStatus().then(function (d) { sendJson(res, 200, d); }); return; }
  if (p === "/api/update" && req.method === "POST") { gitPull().then(function (d) { sendJson(res, d.ok ? 200 : 500, d); }); return; }

  serveStatic(res, p);
}).listen(PORT, "0.0.0.0", function () {
  console.log("RSPro server jalan di http://0.0.0.0:" + PORT);
  console.log("Folder situs : " + PUBLIC);
  console.log("Repo git     : " + ROOT + " (branch " + BRANCH + ")");
  console.log("Update dari Git aktif: POST /api/update");
});