#!/usr/bin/env bash
set -euo pipefail

SOURCE="${TRACKERS_SOURCE:-https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt}"
BLACKLIST_SOURCE="${TRACKERS_BLACKLIST:-https://raw.githubusercontent.com/ngosang/trackerslist/master/blacklist.txt}"
QBIT_URL="${QBIT_URL:-http://127.0.0.1:8080}"
QBIT_USER="${QBIT_USER:-admin}"
QBIT_PASS="${QBIT_PASS:-}"
APPLY=0
MAX=0
ALLOW_HTTP=0

usage() {
  cat <<'EOF'
Uso: sync-public-trackers.sh [opciones]

Descarga una lista pública de trackers BitTorrent, elimina los trackers
incluidos en la blacklist de ngosang/trackerslist y, opcionalmente, los
aplica a qBittorrent como trackers automáticos para descargas nuevas.

Opciones:
  --source URL|ARCHIVO      Lista de trackers (por defecto: trackers_best.txt)
  --blacklist URL|ARCHIVO   Blacklist (por defecto: blacklist.txt)
  --qbittorrent-url URL     URL base de qBittorrent (por defecto: http://127.0.0.1:8080)
  --username USUARIO        Usuario de qBittorrent (por defecto: admin)
  --max N                   Limitar a los N primeros trackers
  --allow-http              Permitir trackers http:// (menos seguro)
  --apply                   Aplicar la lista en qBittorrent
  -h, --help                Mostrar esta ayuda

Credenciales:
  Usa QBIT_PASS en el entorno para evitar que la contraseña aparezca en el
  historial o en la lista de procesos:
    QBIT_PASS='...' ./scripts/sync-public-trackers.sh --apply

Ejemplos:
  ./scripts/sync-public-trackers.sh
  ./scripts/sync-public-trackers.sh --max 20
  QBIT_PASS='...' ./scripts/sync-public-trackers.sh --apply
  ./scripts/sync-public-trackers.sh --source ./trackers_best.txt --max 10
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --blacklist) BLACKLIST_SOURCE="$2"; shift 2 ;;
    --qbittorrent-url) QBIT_URL="$2"; shift 2 ;;
    --username) QBIT_USER="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --allow-http) ALLOW_HTTP=1; shift ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$MAX" =~ ^[0-9]+$ ]]; then
  echo "--max debe ser un número entero" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fetch() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
  else
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 "$src" -o "$dst"
  fi
}

fetch "$SOURCE" "$tmpdir/source.txt"

if [[ -n "$BLACKLIST_SOURCE" ]]; then
  if fetch "$BLACKLIST_SOURCE" "$tmpdir/blacklist.txt" 2>/dev/null; then
    :
  else
    : > "$tmpdir/blacklist.txt"
  fi
else
  : > "$tmpdir/blacklist.txt"
fi

tr -d '\r' < "$tmpdir/source.txt" \
  | awk 'NF && $1 !~ /^#/ {print $1}' \
  | awk '!seen[$0]++' > "$tmpdir/trackers.raw"

tr -d '\r' < "$tmpdir/blacklist.txt" \
  | awk 'NF && $1 !~ /^#/ {print $1}' \
  | awk '!seen[$0]++' > "$tmpdir/blacklist.urls"

awk 'NR==FNR {bad[$0]=1; next} !($0 in bad)' \
  "$tmpdir/blacklist.urls" "$tmpdir/trackers.raw" > "$tmpdir/trackers.filtered"

if [[ "$ALLOW_HTTP" -eq 1 ]]; then
  regex='^(udp|http|https|ws|wss)://[^[:space:]]+$'
else
  regex='^(udp|https|wss)://[^[:space:]]+$'
fi

grep -E "$regex" "$tmpdir/trackers.filtered" > "$tmpdir/trackers.txt" || true

if [[ "$MAX" -gt 0 ]]; then
  head -n "$MAX" "$tmpdir/trackers.txt" > "$tmpdir/trackers.limited"
  mv "$tmpdir/trackers.limited" "$tmpdir/trackers.txt"
fi

count="$(wc -l < "$tmpdir/trackers.txt" | tr -d ' ')"
if [[ "$count" -eq 0 ]]; then
  echo "No quedaron trackers válidos después del filtrado." >&2
  exit 1
fi

echo "Trackers válidos: $count"
echo "Fuente: $SOURCE"
echo "Blacklist: $BLACKLIST_SOURCE"
echo

cat "$tmpdir/trackers.txt"

if [[ "$APPLY" -eq 0 ]]; then
  echo
  echo "Modo simulación. Usa --apply para guardarlos en qBittorrent."
  exit 0
fi

if [[ -z "$QBIT_PASS" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "Contraseña de qBittorrent: " QBIT_PASS
    echo
  else
    echo "Falta QBIT_PASS. Exporta la contraseña de qBittorrent antes de usar --apply." >&2
    exit 2
  fi
fi

base="${QBIT_URL%/}"
cookie="$tmpdir/qbittorrent.cookies"

login_response="$(
  curl -fsS -c "$cookie" \
    -H "Referer: $base" \
    -H "Origin: $base" \
    --data-urlencode "username=$QBIT_USER" \
    --data-urlencode "password=$QBIT_PASS" \
    "$base/api/v2/auth/login"
)"

if [[ "$login_response" != *"Ok."* ]]; then
  echo "No se pudo iniciar sesión en qBittorrent ($base)." >&2
  exit 1
fi

payload="$(
  python3 - "$tmpdir/trackers.txt" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    trackers = fh.read()

print(json.dumps({
    "add_trackers_enabled": True,
    "add_trackers": trackers,
}, ensure_ascii=False))
PY
)"

curl -fsS -b "$cookie" \
  -H "Referer: $base" \
  -H "Origin: $base" \
  --data-urlencode "json=$payload" \
  "$base/api/v2/app/setPreferences" > /dev/null

echo
echo "Lista aplicada en qBittorrent: $base"
echo "Los trackers se añadirán automáticamente a las descargas nuevas."
