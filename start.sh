#!/usr/bin/env sh
# Jalankan server RSPro di VPS/Linux.
# Butuh Node.js & git terpasang. Jalankan dari folder ini (folder yang berisi server.js).
#
# Contoh selalu jalan dengan pm2:
#   pm2 start server.js --name rspro
#   pm2 save
#   pm2 startup
#
# Ubah port lewat env: PORT=9090 ./start.sh
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8080}" node server.js