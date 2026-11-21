#!/usr/bin/env bash
# ==============================================================================
# build-custom-apps.sh — Construcción ARM64 con Podman de Módulos 5 y 6
#
# Construye:
#   - Módulo 5: apps/universal-player -> <registry>/homelab-universal-player:<tag>
#   - Módulo 6: apps/edu-catalog      -> <registry>/homelab-edu-catalog:<tag>
#   - Portal:   apps/family-portal    -> <registry>/homelab-family-portal:<tag>
#
# Opciones de despliegue de imágenes:
#   --import-k3s             Importa los .tar generados en containerd de K3s local
#   --sync-worker <u@host>   Envía e importa los .tar en K3s del nodo rpi-worker vía SSH
#   --push                   Hace `podman push` al registry configurado en --registry
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a && source "${REPO_ROOT}/.env" && set +a
fi

IMAGE_REGISTRY="${IMAGE_REGISTRY:-localhost}"
IMAGE_TAG="${IMAGE_TAG:-arm64}"
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/arm64}"
IMPORT_K3S="false"
PUSH_REGISTRY="false"
SYNC_WORKER=""
DIST_DIR="${REPO_ROOT}/.build-images"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[BUILD]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
  cat <<EOF
Uso: $0 [opciones]

Opciones:
  --platform <plat>        Plataforma OCI destino (defecto: ${TARGET_PLATFORM})
  --registry <reg>         Prefijo de registry (defecto: ${IMAGE_REGISTRY})
  --tag <tag>              Etiqueta de imagen (defecto: ${IMAGE_TAG})
  --import-k3s             Exporta con podman save e importa en k3s ctr local
  --sync-worker <user@ip>  Copia e importa las imágenes en K3s del nodo rpi-worker vía SSH
  --push                   Publica las imágenes con podman push al registry remoto
  -h, --help               Muestra esta ayuda
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)    TARGET_PLATFORM="$2"; shift 2 ;;
    --registry)    IMAGE_REGISTRY="$2"; shift 2 ;;
    --tag)         IMAGE_TAG="$2"; shift 2 ;;
    --import-k3s)  IMPORT_K3S="true"; shift ;;
    --sync-worker) SYNC_WORKER="$2"; shift 2 ;;
    --push)        PUSH_REGISTRY="true"; shift ;;
    -h|--help)     usage ;;
    *) log_error "Opción desconocida: $1"; usage ;;
  esac
done

if ! command -v podman >/dev/null 2>&1; then
  log_error "Podman no está instalado. Ejecuta primero scripts/setup-nodes.sh."
  exit 1
fi

PLAYER_IMAGE="${IMAGE_REGISTRY}/homelab-universal-player:${IMAGE_TAG}"
EDU_IMAGE="${IMAGE_REGISTRY}/homelab-edu-catalog:${IMAGE_TAG}"
PORTAL_IMAGE="${IMAGE_REGISTRY}/homelab-family-portal:${IMAGE_TAG}"

build_image() {
  local name="$1"
  local context_dir="$2"
  local image_ref="$3"

  log_info "Construyendo '${name}' -> ${image_ref} (${TARGET_PLATFORM})..."
  podman build \
    --platform "${TARGET_PLATFORM}" \
    --file "${context_dir}/Containerfile" \
    --tag "${image_ref}" \
    --format oci \
    "${context_dir}"

  local arch size
  arch="$(podman image inspect "${image_ref}" --format '{{.Architecture}}')"
  size="$(podman image inspect "${image_ref}" --format '{{.Size}}' | awk '{printf "%.1f MB", $1/1024/1024}')"
  log_ok "Imagen lista: ${image_ref} | Arch: ${arch} | Tamaño: ${size}"
}

build_image "Módulo 5: Universal Web Player" "${REPO_ROOT}/apps/universal-player" "${PLAYER_IMAGE}"
build_image "Módulo 6: Centro Educativo y Documentales" "${REPO_ROOT}/apps/edu-catalog" "${EDU_IMAGE}"
build_image "Portal familiar Pepflix" "${REPO_ROOT}/apps/family-portal" "${PORTAL_IMAGE}"

if [[ "${IMPORT_K3S}" == "true" || -n "${SYNC_WORKER}" ]]; then
  mkdir -p "${DIST_DIR}"
  PLAYER_TAR="${DIST_DIR}/homelab-universal-player-${IMAGE_TAG}.tar"
  EDU_TAR="${DIST_DIR}/homelab-edu-catalog-${IMAGE_TAG}.tar"
  PORTAL_TAR="${DIST_DIR}/homelab-family-portal-${IMAGE_TAG}.tar"

  log_info "Exportando archivos OCI (.tar) para importación en K3s containerd..."
  podman save --format docker-archive -o "${PLAYER_TAR}" "${PLAYER_IMAGE}"
  podman save --format docker-archive -o "${EDU_TAR}" "${EDU_IMAGE}"
  podman save --format docker-archive -o "${PORTAL_TAR}" "${PORTAL_IMAGE}"

  if [[ "${IMPORT_K3S}" == "true" ]]; then
    if command -v k3s >/dev/null 2>&1; then
      log_info "Importando imágenes en K3s local..."
      sudo k3s ctr images import "${PLAYER_TAR}"
      sudo k3s ctr images import "${EDU_TAR}"
      sudo k3s ctr images import "${PORTAL_TAR}"
      log_ok "Imágenes importadas en K3s local."
    else
      log_warn "No se encontró el binario 'k3s' en este nodo; se omitió la importación local."
    fi
  fi

  if [[ -n "${SYNC_WORKER}" ]]; then
    log_info "Sincronizando e importando imágenes en nodo worker (${SYNC_WORKER})..."
    scp -q "${PLAYER_TAR}" "${EDU_TAR}" "${PORTAL_TAR}" "${SYNC_WORKER}:/tmp/"
    ssh "${SYNC_WORKER}" "sudo k3s ctr images import /tmp/$(basename "${PLAYER_TAR}") && sudo k3s ctr images import /tmp/$(basename "${EDU_TAR}") && sudo k3s ctr images import /tmp/$(basename "${PORTAL_TAR}") && rm -f /tmp/$(basename "${PLAYER_TAR}") /tmp/$(basename "${EDU_TAR}") /tmp/$(basename "${PORTAL_TAR}")"
    log_ok "Imágenes importadas correctamente en ${SYNC_WORKER}."
  fi
fi

if [[ "${PUSH_REGISTRY}" == "true" ]]; then
  if [[ "${IMAGE_REGISTRY}" == "localhost" ]]; then
    log_error "No se puede hacer push a 'localhost'. Especifica --registry <host:port>."
    exit 1
  fi
  log_info "Publicando imágenes en ${IMAGE_REGISTRY}..."
  podman push "${PLAYER_IMAGE}"
  podman push "${EDU_IMAGE}"
  podman push "${PORTAL_IMAGE}"
  log_ok "Imágenes publicadas en ${IMAGE_REGISTRY}."
fi

log_ok "Proceso de construcción ARM64 finalizado."
