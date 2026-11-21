#!/usr/bin/env bash
# ==============================================================================
# setup-nodes.sh — Aprovisionamiento de Nodos Raspberry Pi (ARM64)
# Prepara OS, cgroups K3s, Podman, NFS (/mnt/storage), estructura TRaSH Guides,
# permisos PUID=1000/PGID=1000 y (opcionalmente) el clúster K3s de 2 nodos.
#
# Uso:
#   Nodo 1 (rpi-master):
#     sudo ./scripts/setup-nodes.sh --role master --subnet 192.168.1.0/24 [--install-k3s]
#   Nodo 2 (rpi-worker):
#     sudo ./scripts/setup-nodes.sh --role worker --master-ip 192.168.1.50 [--install-k3s --k3s-token <TOKEN>]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Cargar .env si existe
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a && source "${REPO_ROOT}/.env" && set +a
fi

# Valores por defecto
ROLE=""
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
STORAGE_ROOT="${STORAGE_ROOT:-/mnt/storage}"
LAN_SUBNET="${LAN_SUBNET:-192.168.1.0/24}"
MASTER_IP="${MASTER_IP:-}"
MASTER_HOSTNAME="${MASTER_HOSTNAME:-rpi-master}"
WORKER_HOSTNAME="${WORKER_HOSTNAME:-rpi-worker}"
EXTERNAL_DISK_DEVICE="${EXTERNAL_DISK_DEVICE:-}"
INSTALL_K3S="false"
K3S_TOKEN=""
SKIP_PACKAGES="false"

# Colores para salida legible
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
  cat <<EOF
Uso: sudo $0 --role <master|worker> [opciones]

Opciones obligatorias:
  --role <master|worker>      Rol del nodo (master=rpi-master, worker=rpi-worker)

Opciones generales:
  --storage <ruta>            Ruta compartida (defecto: ${STORAGE_ROOT})
  --puid <uid>                UID propietario multimedia (defecto: ${PUID})
  --pgid <gid>                GID propietario multimedia (defecto: ${PGID})
  --subnet <CIDR>             Subred LAN autorizada para NFS en master (defecto: ${LAN_SUBNET})
  --master-ip <IP>            IP del nodo master (obligatorio en --role worker)
  --disk <dispositivo>        Partición externa en master a montar en ${STORAGE_ROOT} (ej. /dev/sda1)
  --install-k3s               Instala K3s (server en master, agent en worker)
  --k3s-token <token>         Token de K3s del master (requerido con --role worker --install-k3s)
  --skip-packages             Omite apt-get install (útil si ya están instalados)
  -h, --help                  Muestra esta ayuda
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)           ROLE="$2"; shift 2 ;;
    --storage)        STORAGE_ROOT="$2"; shift 2 ;;
    --puid)           PUID="$2"; shift 2 ;;
    --pgid)           PGID="$2"; shift 2 ;;
    --subnet)         LAN_SUBNET="$2"; shift 2 ;;
    --master-ip)      MASTER_IP="$2"; shift 2 ;;
    --disk)           EXTERNAL_DISK_DEVICE="$2"; shift 2 ;;
    --install-k3s)    INSTALL_K3S="true"; shift ;;
    --k3s-token)      K3S_TOKEN="$2"; shift 2 ;;
    --skip-packages)  SKIP_PACKAGES="true"; shift ;;
    -h|--help)        usage ;;
    *) log_error "Opción desconocida: $1"; usage ;;
  esac
done

# ------------------------------------------------------------------------------
# 1. Validaciones iniciales
# ------------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
  log_error "Este script debe ejecutarse como root (usa sudo)."
  exit 1
fi

if [[ "${ROLE}" != "master" && "${ROLE}" != "worker" ]]; then
  log_error "Debes indicar --role master o --role worker."
  usage
fi

if [[ "${ROLE}" == "worker" && -z "${MASTER_IP}" ]]; then
  log_error "En modo worker es obligatorio indicar --master-ip <IP_DEL_MASTER>."
  exit 1
fi

ARCH="$(uname -m)"
if [[ "${ARCH}" != "aarch64" && "${ARCH}" != "arm64" ]]; then
  log_warn "Arquitectura detectada: ${ARCH}. Este stack está optimizado para Raspberry Pi ARM64 (aarch64)."
else
  log_ok "Arquitectura ARM64 verificada (${ARCH})."
fi

# ------------------------------------------------------------------------------
# 2. Hostname y parámetros de kernel / cgroups para Raspberry Pi
# ------------------------------------------------------------------------------
TARGET_HOSTNAME="$([[ "${ROLE}" == "master" ]] && echo "${MASTER_HOSTNAME}" || echo "${WORKER_HOSTNAME}")"
CURRENT_HOSTNAME="$(hostname)"
if [[ "${CURRENT_HOSTNAME}" != "${TARGET_HOSTNAME}" ]]; then
  log_info "Estableciendo hostname '${TARGET_HOSTNAME}' (anterior: '${CURRENT_HOSTNAME}')..."
  hostnamectl set-hostname "${TARGET_HOSTNAME}" || echo "${TARGET_HOSTNAME}" > /etc/hostname
  if ! grep -qE "127\.0\.1\.1\s+${TARGET_HOSTNAME}" /etc/hosts; then
    echo "127.0.1.1 ${TARGET_HOSTNAME}" >> /etc/hosts
  fi
fi

configure_rpi_cgroups() {
  local cmdline_file=""
  if [[ -f /boot/firmware/cmdline.txt ]]; then
    cmdline_file="/boot/firmware/cmdline.txt"
  elif [[ -f /boot/cmdline.txt ]]; then
    cmdline_file="/boot/cmdline.txt"
  fi

  if [[ -n "${cmdline_file}" ]]; then
    local needs_reboot="false"
    for param in "cgroup_memory=1" "cgroup_enable=memory"; do
      if ! grep -qw "${param}" "${cmdline_file}"; then
        sed -i "s/\$/ ${param}/" "${cmdline_file}"
        needs_reboot="true"
      fi
    done
    if [[ "${needs_reboot}" == "true" ]]; then
      log_warn "Se añadieron parámetros de cgroup en ${cmdline_file}. Reinicia la Raspberry Pi antes de iniciar K3s."
    else
      log_ok "Cgroups de memoria ya activos en ${cmdline_file}."
    fi
  else
    log_info "No se encontró cmdline.txt de Raspberry Pi; verificando cgroupv2 estándar."
  fi
}

configure_rpi_cgroups

# Ajustes sysctl recomendados para contenedores, inotify (Jellyfin/Navidrome) y red
cat <<'EOF' > /etc/sysctl.d/99-homelab-media.conf
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
net.ipv4.ip_forward = 1
vm.swappiness = 10
EOF
sysctl --system >/dev/null 2>&1 || true
log_ok "Parámetros sysctl aplicados."

# ------------------------------------------------------------------------------
# 3. Instalación de Podman y utilidades NFS
# ------------------------------------------------------------------------------
if [[ "${SKIP_PACKAGES}" == "false" ]]; then
  log_info "Actualizando repositorios e instalando Podman y utilidades NFS..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq

  COMMON_PKGS=(
    podman
    crun
    slirp4netns
    fuse-overlayfs
    uidmap
    curl
    jq
    ca-certificates
    gnupg
    nfs-common
    acl
  )

  if [[ "${ROLE}" == "master" ]]; then
    COMMON_PKGS+=(nfs-kernel-server)
  fi

  apt-get install -y -qq "${COMMON_PKGS[@]}"
  log_ok "Paquetes instalados: Podman $(podman --version | awk '{print $3}')."
fi

# Configurar registros por defecto para Podman
mkdir -p /etc/containers/registries.conf.d
cat <<'EOF' > /etc/containers/registries.conf.d/10-homelab-registries.conf
unqualified-search-registries = ["docker.io", "ghcr.io", "lscr.io"]
EOF
log_ok "Registros OCI de Podman configurados."

# ------------------------------------------------------------------------------
# 4. Usuario y permisos PUID=1000 / PGID=1000 (+ grupos V4L2 en worker)
# ------------------------------------------------------------------------------
if ! getent group "${PGID}" >/dev/null; then
  groupadd -g "${PGID}" media
  log_ok "Grupo 'media' creado con PGID=${PGID}."
fi
MEDIA_GROUP="$(getent group "${PGID}" | cut -d: -f1)"

if ! getent passwd "${PUID}" >/dev/null; then
  useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash media
  log_ok "Usuario 'media' creado con PUID=${PUID}."
fi
MEDIA_USER="$(getent passwd "${PUID}" | cut -d: -f1)"

# Asegurar acceso a aceleración de vídeo V4L2 (/dev/video10-12) en Raspberry Pi
for hw_group in video render; do
  if getent group "${hw_group}" >/dev/null; then
    usermod -aG "${hw_group}" "${MEDIA_USER}" || true
  fi
done
log_ok "Usuario '${MEDIA_USER}' (UID=${PUID}, GID=${PGID}) verificado."

# Habilitar linger para Podman rootless si el usuario desea ejecutar pods sin root
loginctl enable-linger "${MEDIA_USER}" 2>/dev/null || true

# ------------------------------------------------------------------------------
# 5. Almacenamiento Compartido NFS y Jerarquía TRaSH Guides
# ------------------------------------------------------------------------------
mkdir -p "${STORAGE_ROOT}"

if [[ "${ROLE}" == "master" ]]; then
  # Montar disco externo opcional si fue especificado
  if [[ -n "${EXTERNAL_DISK_DEVICE}" && -b "${EXTERNAL_DISK_DEVICE}" ]]; then
    DISK_UUID="$(blkid -s UUID -o value "${EXTERNAL_DISK_DEVICE}")"
    DISK_FSTYPE="$(blkid -s TYPE -o value "${EXTERNAL_DISK_DEVICE}")"
    if [[ -n "${DISK_UUID}" ]] && ! grep -q "${DISK_UUID}" /etc/fstab; then
      echo "UUID=${DISK_UUID} ${STORAGE_ROOT} ${DISK_FSTYPE} defaults,noatime,nofail 0 2" >> /etc/fstab
      log_ok "Disco externo ${EXTERNAL_DISK_DEVICE} (${DISK_FSTYPE}) registrado en /etc/fstab."
    fi
    if ! mountpoint -q "${STORAGE_ROOT}"; then
      mount "${STORAGE_ROOT}"
      log_ok "Disco externo montado en ${STORAGE_ROOT}."
    fi
  fi

  log_info "Creando jerarquía TRaSH Guides en ${STORAGE_ROOT}..."
  mkdir -p \
    "${STORAGE_ROOT}/torrents/movies" \
    "${STORAGE_ROOT}/torrents/tv" \
    "${STORAGE_ROOT}/torrents/music" \
    "${STORAGE_ROOT}/torrents/documentaries" \
    "${STORAGE_ROOT}/torrents/incomplete" \
    "${STORAGE_ROOT}/media/movies" \
    "${STORAGE_ROOT}/media/tv" \
    "${STORAGE_ROOT}/media/music/playlists" \
    "${STORAGE_ROOT}/media/podcasts" \
    "${STORAGE_ROOT}/media/documentaries" \
    "${STORAGE_ROOT}/media/personal_videos" \
    "${STORAGE_ROOT}/recycle_bin/movies" \
    "${STORAGE_ROOT}/recycle_bin/tv" \
    "${STORAGE_ROOT}/recycle_bin/music" \
    "${STORAGE_ROOT}/appdata/homepage" \
    "${STORAGE_ROOT}/appdata/jellyfin/config" \
    "${STORAGE_ROOT}/appdata/jellyfin/cache" \
    "${STORAGE_ROOT}/appdata/navidrome" \
    "${STORAGE_ROOT}/appdata/threadfin/conf" \
    "${STORAGE_ROOT}/appdata/edu-catalog" \
    "${STORAGE_ROOT}/appdata/jellyseerr" \
    "${STORAGE_ROOT}/appdata/prowlarr" \
    "${STORAGE_ROOT}/appdata/sonarr" \
    "${STORAGE_ROOT}/appdata/radarr" \
    "${STORAGE_ROOT}/appdata/lidarr" \
    "${STORAGE_ROOT}/appdata/bazarr" \
    "${STORAGE_ROOT}/appdata/qbittorrent" \
    "${STORAGE_ROOT}/appdata/reports" \
    "${STORAGE_ROOT}/appdata/czkawka"

  # Semilla legal de playlists M3U de radios libres y podcasts para Navidrome (solo si no existen)
  RADIOS_M3U="${STORAGE_ROOT}/media/music/playlists/radios-libres.m3u"
  if [[ ! -f "${RADIOS_M3U}" ]]; then
    cat <<'EOF' > "${RADIOS_M3U}"
#EXTM3U
#EXTINF:-1,SomaFM - Groove Salad (Ambient / Downtempo Libre)
https://ice1.somafm.com/groovesalad-128-mp3
#EXTINF:-1,SomaFM - Drone Zone (Focus / Atmospheric)
https://ice1.somafm.com/dronezone-128-mp3
#EXTINF:-1,SomaFM - DEF CON Radio (Hacker / Electronic)
https://ice1.somafm.com/defcon-128-mp3
#EXTINF:-1,Radio Paradise - Main Mix (Listener-Supported)
https://stream.radioparadise.com/aac-128
#EXTINF:-1,RNE Radio 3 (RTVE — Cultura y Música)
https://rtvelivestream.akamaized.net/rtvesec/rne/rne_r3_main.m3u8
#EXTINF:-1,Nightride FM - Synthwave
https://stream.nightride.fm/nightride.m4a
EOF
    log_ok "Playlist inicial de radios libres creada en ${RADIOS_M3U}."
  fi

  PODCASTS_M3U="${STORAGE_ROOT}/media/music/playlists/podcasts-abiertos.m3u"
  if [[ ! -f "${PODCASTS_M3U}" ]]; then
    cat <<'EOF' > "${PODCASTS_M3U}"
#EXTM3U
#EXTINF:-1,RNE Radio Clásica (RTVE — Música y Divulgación)
https://rtvelivestream.akamaized.net/rtvesec/rne/rne_r2_main.m3u8
#EXTINF:-1,FIP Radio (Radio France — Ecléctica)
https://icecast.radiofrance.fr/fip-midfi.mp3
EOF
    log_ok "Playlist inicial de cultura/podcasts creada en ${PODCASTS_M3U}."
  fi

  # Semilla de configuración de Homepage para modo Podman (`media-pod.yaml`)
  HP_DIR="${STORAGE_ROOT}/appdata/homepage"
  if [[ ! -f "${HP_DIR}/services.yaml" ]]; then
    cat <<'EOF' > "${HP_DIR}/settings.yaml"
title: Pepflix · Homelab Media Hub (Podman ARM64)
description: Ecosistema Multimedia Autohospedado — Modo Podman Kube Play
theme: dark
color: slate
headerStyle: clean
statusStyle: dot
EOF
    cat <<'EOF' > "${HP_DIR}/widgets.yaml"
- resources:
    cpu: true
    memory: true
    disk: /
- search:
    provider: duckduckgo
    target: _blank
- datetime:
    text_size: lg
    format:
      dateStyle: medium
      timeStyle: short
EOF
    cat <<'EOF' > "${HP_DIR}/services.yaml"
- Streaming & Medios:
    - Jellyfin:
        icon: jellyfin.png
        href: http://localhost:8096
        description: Cine, Series, Vídeos Personales y Live TV
    - Jellyseerr (Peticiones):
        icon: jellyseerr.png
        href: http://localhost:5055
        description: Peticiones de películas y series
    - Navidrome:
        icon: navidrome.png
        href: http://localhost:4533
        description: Música FLAC/MP3, Radios Libres M3U y Podcasts (RO)
    - Threadfin (FAST / Live TV):
        icon: mdi-television-classic-#38bdf8
        href: http://localhost:34400
        description: Proxy M3U/EPG para Pluto TV, RTVE Play y TDTChannels
- Apps Web & Educación:
    - Pepflix Family:
        icon: mdi-account-group-#ffc857
        href: http://localhost:8088
        description: Portal familiar con enlaces a Jellyfin, peticiones, TV y documentales
    - Universal Player PWA:
        icon: mdi-play-circle-#818cf8
        href: http://localhost:8085
        description: Reproductor local-first de vídeo/audio + subtítulos SRT/VTT
    - Centro Educativo & Documentales:
        icon: wikipedia.png
        href: http://localhost:8000
        description: Catálogo legal (Internet Archive, NASA, MIT OCW, Wikimedia)
        widget:
          type: customapi
          url: http://127.0.0.1:8000/api/stats
          mappings:
            - field: total_items
              label: Recursos
            - field: favorites
              label: Favoritos
            - field: watched
              label: Vistos
- Automatización (*arr & Descargas):
    - Prowlarr:
        icon: prowlarr.png
        href: http://localhost:9696
        description: Indexers y trackers abiertos/legales
    - Radarr:
        icon: radarr.png
        href: http://localhost:7878
        description: Películas y documentales (hardlinks)
    - Sonarr:
        icon: sonarr.png
        href: http://localhost:8989
        description: Series (hardlinks)
    - Lidarr:
        icon: lidarr.png
        href: http://localhost:8686
        description: Música y MusicBrainz (hardlinks)
    - Bazarr:
        icon: bazarr.png
        href: http://localhost:6767
        description: Subtítulos automáticos
    - qBittorrent:
        icon: qbittorrent.png
        href: http://localhost:8080
        description: Cliente de descargas en /data/torrents
EOF
    cat <<'EOF' > "${HP_DIR}/bookmarks.yaml"
- Fuentes Legales:
    - Internet Archive:
        - abbr: IA
          href: https://archive.org/details/movies
    - NASA+:
        - abbr: NS
          href: https://plus.nasa.gov/
    - MIT OpenCourseWare:
        - abbr: MIT
          href: https://ocw.mit.edu/
    - TDTChannels:
        - abbr: TDT
          href: https://www.tdtchannels.com/
EOF
    log_ok "Configuración inicial de Homepage para Podman creada en ${HP_DIR}."
  fi

  # Aplicar propiedad PUID:PGID y permisos limpios (sin borrar nada existente)
  chown -R "${PUID}:${PGID}" "${STORAGE_ROOT}"
  chmod -R u+rwX,g+rwX,o+rX "${STORAGE_ROOT}"
  log_ok "Estructura TRaSH Guides y permisos ${PUID}:${PGID} aplicados en ${STORAGE_ROOT}."

  # Exportar /mnt/storage por NFS hacia la subred local
  EXPORT_LINE="${STORAGE_ROOT} ${LAN_SUBNET}(rw,sync,no_subtree_check,all_squash,anonuid=${PUID},anongid=${PGID})"
  if grep -q "^${STORAGE_ROOT} " /etc/exports 2>/dev/null; then
    sed -i "\|^${STORAGE_ROOT} |c\\${EXPORT_LINE}" /etc/exports
  else
    echo "${EXPORT_LINE}" >> /etc/exports
  fi

  systemctl enable --now nfs-kernel-server
  exportfs -ra
  log_ok "NFSv4 configurado y exportando ${STORAGE_ROOT} a ${LAN_SUBNET}."

else
  # Modo WORKER: montar /mnt/storage vía NFS desde rpi-master
  FSTAB_ENTRY="${MASTER_IP}:${STORAGE_ROOT} ${STORAGE_ROOT} nfs4 defaults,_netdev,noatime,rsize=1048576,wsize=1048576,soft,timeo=60 0 0"
  if grep -q " ${STORAGE_ROOT} nfs" /etc/fstab 2>/dev/null; then
    sed -i "\| ${STORAGE_ROOT} nfs|c\\${FSTAB_ENTRY}" /etc/fstab
  else
    echo "${FSTAB_ENTRY}" >> /etc/fstab
  fi

  if mountpoint -q "${STORAGE_ROOT}"; then
    log_ok "${STORAGE_ROOT} ya se encuentra montado en el nodo worker."
  else
    log_info "Montando NFS ${MASTER_IP}:${STORAGE_ROOT} -> ${STORAGE_ROOT}..."
    mount -t nfs4 "${MASTER_IP}:${STORAGE_ROOT}" "${STORAGE_ROOT}"
    log_ok "Almacenamiento compartido NFS montado correctamente en ${STORAGE_ROOT}."
  fi

  # Verificar dispositivos de aceleración hardware V4L2 en Raspberry Pi
  for dev in /dev/video10 /dev/video11 /dev/video12; do
    if [[ -c "${dev}" ]]; then
      log_ok "Dispositivo V4L2 detectado: ${dev}"
    else
      log_warn "Dispositivo ${dev} no detectado en este hardware (ajusta jellyfin.yaml si usas RPi 5 o VM)."
    fi
  done
fi

# ------------------------------------------------------------------------------
# 6. Instalación opcional de K3s (2 nodos: rpi-master + rpi-worker)
# ------------------------------------------------------------------------------
if [[ "${INSTALL_K3S}" == "true" ]]; then
  if [[ "${ROLE}" == "master" ]]; then
    log_info "Instalando K3s Control-Plane en ${TARGET_HOSTNAME} (con Traefik habilitado)..."
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
      --node-name ${MASTER_HOSTNAME} \
      --write-kubeconfig-mode 644 \
      --node-label homelab.role=control-management" sh -

    # Configurar kubeconfig para el usuario media
    MEDIA_HOME="$(eval echo "~${MEDIA_USER}")"
    mkdir -p "${MEDIA_HOME}/.kube"
    cp /etc/rancher/k3s/k3s.yaml "${MEDIA_HOME}/.kube/config"
    chown -R "${PUID}:${PGID}" "${MEDIA_HOME}/.kube"

    NODE_TOKEN="$(cat /var/lib/rancher/k3s/server/node-token)"
    log_ok "K3s Master listo."
    echo -e "${GREEN}==================================================================${NC}"
    echo -e "Token para unir a ${WORKER_HOSTNAME}:"
    echo -e "  ${YELLOW}${NODE_TOKEN}${NC}"
    echo -e "Ejecuta en ${WORKER_HOSTNAME}:"
    echo -e "  sudo ./scripts/setup-nodes.sh --role worker --master-ip $(hostname -I | awk '{print $1}') --install-k3s --k3s-token '${NODE_TOKEN}'"
    echo -e "${GREEN}==================================================================${NC}"
  else
    if [[ -z "${K3S_TOKEN}" ]]; then
      log_error "Para --role worker --install-k3s debes indicar --k3s-token <TOKEN>."
      exit 1
    fi
    log_info "Instalando K3s Worker Agent en ${TARGET_HOSTNAME} -> https://${MASTER_IP}:6443..."
    curl -sfL https://get.k3s.io | K3S_URL="https://${MASTER_IP}:6443" \
      K3S_TOKEN="${K3S_TOKEN}" \
      INSTALL_K3S_EXEC="agent \
        --node-name ${WORKER_HOSTNAME} \
        --node-label homelab.role=media-streaming" sh -
    log_ok "K3s Worker unido al clúster correctamente."
  fi
fi

log_ok "Aprovisionamiento completado para el nodo '${TARGET_HOSTNAME}' (rol: ${ROLE})."
