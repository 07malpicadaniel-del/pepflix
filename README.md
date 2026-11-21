# Homelab Media Stack — Ecosistema Multimedia Autohospedado (2x Raspberry Pi ARM64)

Repositorio completo de **Infraestructura como Código (IaC)**, manifiestos **Kubernetes (K3s + Kustomize)**, modo compatible con **Podman (`podman kube play`)**, scripts de aprovisionamiento y aplicaciones web personalizadas para desplegar un ecosistema multimedia centralizado, gratuito, legal y no destructivo sobre **2 nodos Raspberry Pi (`linux/arm64`)**.

---

## 1. Arquitectura y Distribución en 2 Raspberry Pi

```text
                       [ Dispositivos en Red Local (*.media.local) ]
                                            │
                            [ Traefik Ingress (K3s en rpi-master) ]
                                            │
       ┌────────────────────┬───────────────┼───────────────┬────────────────────┐
       ▼                    ▼               ▼               ▼                    ▼
 [ Homepage ]         [ Jellyfin ]    [ Navidrome ]   [ Edu Catalog ]   [ Universal Player ]
  rpi-master           rpi-worker      rpi-worker      rpi-worker          rpi-worker
  (Portal K8s)        (V4L2 + RO)     (Música RO)     (FastAPI+SQLite)   (Local-First PWA)
                           ▲               ▲                ▲
                           │ (Webhooks)    │ (Hardlinks)    │
                     ┌─────┴───────────────┴────────────────┘
                     │  /mnt/storage/media/  (NFS Compartido — Montado RO en reproductores)
                     └─────────────────────▲──────────────────────┐
                                           │ (Hardlinks atómicos) │ (CronJob RO)
                     ┌─────────────────────┴──────────────┐  ┌────┴──────────────────┐
                     │  Sonarr / Radarr / Lidarr / Bazarr │  │ Czkawka CLI Scanner   │
                     │           (rpi-master)             │  │ (Solo reporte JSON/HT)│
                     └─────────────────────▲──────────────┘  └───────────────────────┘
                                           │ (API Sync)
                     ┌─────────────────────┴──────────────┐
                     │  Prowlarr  ──►  qBittorrent        │ ──► /mnt/storage/torrents/
                     │  (Indexers/Trackers Abiertos)      │
                     └────────────────────────────────────┘
```

### Mapa de Módulos, Servicios y Nodos

| Módulo | Servicio | Imagen ARM64 | Nodo Objetivo | Puerto | Subdominio (`*.media.local`) | Montaje Media |
|---|---|---|---|---|---|---|
| **1** | **Homepage** (Portal + RBAC) | `ghcr.io/gethomepage/homepage:latest` | `rpi-master` | `3000` | `media.local` / `portal.media.local` | — |
| **2** | **Jellyfin** (Cine/Series/TV) | `jellyfin/jellyfin:latest` | `rpi-worker` *(anclado)* | `8096` | `jellyfin.media.local` | `/media` (**RO**) + `/dev/video10-12` |
| **3** | **Navidrome** (Música/Radios) | `deluan/navidrome:latest` | `rpi-worker` | `4533` | `music.media.local` | `/music` (**RO**) |
| **4** | **Threadfin** (FAST/Live TV) | `fyb3roptik/threadfin:latest` | `rpi-worker` | `34400` | `tv.media.local` | — |
| **5** | **Universal Player** (PWA) | `localhost/homelab-universal-player:arm64` | `rpi-worker` | `8085` | `player.media.local` | 100% Local-First (navegador) |
| **6** | **Edu Catalog** (Documentales) | `localhost/homelab-edu-catalog:arm64` | `rpi-worker` | `8000` | `edu.media.local` | SQLite en `appdata/edu-catalog` |
| **8** | **Jellyseerr** (Peticiones) | `fallenbagel/jellyseerr:latest` | `rpi-worker` | `5055` | `jellyseerr.media.local` | — |
| **8** | **Portal familiar Pepflix** | `localhost/homelab-family-portal:arm64` | `rpi-worker` | `8088` | `pepflix.media.local` | — |
| **7** | **Prowlarr** | `lscr.io/linuxserver/prowlarr:latest` | `rpi-master` | `9696` | `prowlarr.media.local` | — |
| **7** | **Radarr** | `lscr.io/linuxserver/radarr:latest` | `rpi-master` | `7878` | `radarr.media.local` | `/data` (único — hardlinks) |
| **7** | **Sonarr** | `lscr.io/linuxserver/sonarr:latest` | `rpi-master` | `8989` | `sonarr.media.local` | `/data` (único — hardlinks) |
| **7** | **Lidarr** | `lscr.io/linuxserver/lidarr:latest` | `rpi-master` | `8686` | `lidarr.media.local` | `/data` (único — hardlinks) |
| **7** | **Bazarr** | `lscr.io/linuxserver/bazarr:latest` | `rpi-master` | `6767` | `bazarr.media.local` | `/data` |
| **7** | **qBittorrent** | `lscr.io/linuxserver/qbittorrent:latest` | `rpi-master` | `8080` / `6881` | `downloads.media.local` | `/data` (único — hardlinks) |
| **7** | **Czkawka Scanner** (CronJob) | `python:3.11-slim` + `czkawka_cli` ARM64 | `rpi-master` | Cron `0 4 * * 0` | Informes en `appdata/reports/` | `/media` (**RO**) |

### Presupuesto de Memoria Calibrado para 2x Raspberry Pi 4 (4 GB RAM c/u)

Todos los manifiestos de `k8s/base/` y `k8s/podman-compatible/media-pod.yaml` están calibrados específicamente para **Raspberry Pi 4 de 4 GB (~3.8 GiB útiles por nodo)** dejando siempre **>1 GiB de margen libre** para el sistema operativo, caché de página Linux y buffers V4L2/NFS:

| Nodo (RPi 4 · 4 GB) | Cargas Permanentes | Requests RAM | Limits Máximos Simultáneos | Overhead OS + K3s | Margen Libre Estimado |
|---|---|---:|---:|---:|---:|
| **`rpi-master`** | Homepage (`96/256Mi`), Prowlarr (`96/256Mi`), Radarr (`128/320Mi`), Sonarr (`128/320Mi`), Lidarr (`128/320Mi`), Bazarr (`160/320Mi`), qBittorrent (`128/448Mi`) | **864 MiB** | **2,240 MiB (~2.19 GiB)** | ~750 MiB | **~0.85–1.0 GiB** |
| **`rpi-worker`** | Jellyfin (`384/1536Mi`), Jellyseerr (`96/320Mi`), Navidrome (`48/128Mi`), Threadfin (`32/128Mi`), Universal Player (`24/64Mi`), Edu Catalog (`64/192Mi`), Portal Pepflix (`24/64Mi`) | **672 MiB** | **2,432 MiB (~2.38 GiB)** | ~300 MiB | **~0.75 GiB** |

> **Consejo para RPi 4 (4 GB):** El CronJob `czkawka-duplicate-scanner` corre únicamente los domingos a las 04:00 (`64Mi` req / `256Mi` lim). Si en algún momento no utilizas Lidarr o Bazarr, puedes escalar sus réplicas a `0` (`kubectl -n homelab-media scale deploy/lidarr --replicas=0`) para liberar RAM adicional.

### Despliegue Temporal en PC Local (Arch Linux / Docker Compose)

Si aún estás esperando el hardware/ventilación de las Raspberry Pi y quieres levantar todo el ecosistema en tu PC actual (con Docker Compose):

```bash
cd /home/daniel/.gemini/antigravity-ide/scratch/homelab-media-stack
docker compose -f docker-compose.local-pc.yml up -d --build
```

Portal centralizado disponible en `http://localhost:3000` y portal familiar Pepflix en `http://localhost:8088` (integrando los contenedores `*arr`/qBittorrent ya activos en tu PC junto con Jellyfin `:8096`, Navidrome `:4533`, Threadfin `:34400`, Universal Player PWA `:8085`, Centro Educativo `:8000`, Lidarr `:8686` y Bazarr `:6767`).

---

## 2. Reglas Críticas de Diseño

1. **No-Borrado Estrictamente Aplicado:**
   - `StorageClass` y `PersistentVolume` usan `reclaimPolicy: Retain`.
   - Jellyfin (`/media`), Navidrome (`/music`) y Czkawka Scanner (`/media`) montan el almacenamiento con `readOnly: true` a nivel de kernel.
   - Los servicios `*arr` utilizan papelera de seguridad obligatoria en `/data/recycle_bin/`.
2. **Hardlinks Atómicos (TRaSH Guides):**
   - Toda la jerarquía (`torrents/`, `media/`, `recycle_bin/`, `appdata/`) reside dentro de `/mnt/storage`.
   - `*arr` y `qBittorrent` montan **un único volumen `/data` -> `/mnt/storage`** (sin dividir `torrents` y `media` en montajes separados) para evitar `EXDEV` y permitir enlaces duros instantáneos con **0 bytes adicionales**.
3. **Protección de Recursos Raspberry Pi:** Todos los Deployments y CronJobs definen `resources.requests` y `resources.limits` calibrados para Raspberry Pi 4/5 (4 GB–8 GB RAM).
4. **Cumplimiento Legal y Ético:** Plantillas, catálogos, radios y listas TV configuradas exclusivamente para contenido propio, dominio público, Creative Commons, NASA, MIT OpenCourseWare, Internet Archive, Wikimedia Commons y plataformas FAST oficiales (Pluto TV, RTVE Play, TDTChannels).
5. **Hardening por defecto:** Pod Security Standards en `baseline`, `NetworkPolicy` con denegación por defecto, portal familiar sin privilegios y separación entre la experiencia de familia y los paneles de administración. Detalles y excepciones en [`docs/INDEXERS-Y-TRACKERS.md`](docs/INDEXERS-Y-TRACKERS.md).

---

## 3. Despliegue Paso a Paso en las 2 Raspberry Pi

### Requisitos Previos
- **2 Raspberry Pi 4 o 5** (4 GB u 8 GB RAM recomendados) con **Raspberry Pi OS Lite (64-bit)** o **Ubuntu Server 24.04 ARM64**.
- **IPs estáticas** en tu router (ejemplo usado aquí: `rpi-master = 192.168.1.50`, `rpi-worker = 192.168.1.51`).
- Disco externo USB 3.0 SSD/HDD (formateado en `ext4`) conectado a `rpi-master`.

### Paso 1: Configurar Variables y Aprovisionar ambos Nodos

Clona o copia el repositorio en ambas Raspberry Pi y crea tu archivo `.env`:

```bash
cp .env.example .env
nano .env
```

#### En Nodo 1 (`rpi-master` — Control-Plane + NFS Server)
```bash
chmod +x scripts/setup-nodes.sh scripts/build-custom-apps.sh

# Si tienes un disco externo en /dev/sda1 añade `--disk /dev/sda1`
sudo ./scripts/setup-nodes.sh \
  --role master \
  --subnet 192.168.1.0/24 \
  --install-k3s
```
> **Nota:** Si el script añadió `cgroup_memory=1 cgroup_enable=memory` en `/boot/firmware/cmdline.txt`, reinicia la Pi (`sudo reboot`) y vuelve a ejecutar con `--skip-packages --install-k3s`. Al finalizar, guarda el **`K3S_TOKEN`** mostrado por pantalla.

#### En Nodo 2 (`rpi-worker` — Worker Multimedia + Cliente NFS)
```bash
chmod +x scripts/setup-nodes.sh scripts/build-custom-apps.sh

sudo ./scripts/setup-nodes.sh \
  --role worker \
  --master-ip 192.168.1.50 \
  --install-k3s \
  --k3s-token "<PEGA_AQUI_EL_TOKEN_DEL_MASTER>"
```

Verifica desde `rpi-master` que ambos nodos están `Ready` y que el montaje NFS es visible en ambos:
```bash
kubectl get nodes -o wide --show-labels
ls -la /mnt/storage
```

---

### Paso 2: Construir las Aplicaciones Web Personalizadas (Módulos 5, 6 y Portal Pepflix) en ARM64

Ejecuta `scripts/build-custom-apps.sh` con **Podman** (en `rpi-worker` directamente, o desde `rpi-master` sincronizando automáticamente los `.tar` hacia `rpi-worker`):

```bash
# Opción A: Ejecutar desde rpi-master y sincronizar a ambos nodos K3s
./scripts/build-custom-apps.sh \
  --platform linux/arm64 \
  --import-k3s \
  --sync-worker pi@192.168.1.51

# Opción B: Ejecutar directamente en rpi-worker
./scripts/build-custom-apps.sh --platform linux/arm64 --import-k3s
```

Comprueba en `rpi-worker` que containerd de K3s tiene las imágenes cargadas:
```bash
sudo k3s ctr images list | grep homelab-
```

---

### Paso 3A: Despliegue en Kubernetes / K3s (Opción Recomendada)

Desde `rpi-master`:
```bash
# 1. Validar los manifiestos generados por Kustomize
kubectl kustomize k8s/base > /dev/null && echo "Kustomize OK"

# 2. Desplegar el ecosistema completo
kubectl apply -k k8s/base

# 3. Supervisar el arranque y la ubicación por nodo (rpi-master vs rpi-worker)
kubectl -n homelab-media get pods -o wide -w
```

> **Nota para Raspberry Pi 5:** Si tu RPi 5 no expone `/dev/video12`, comenta el bloque `video12` en `k8s/base/jellyfin.yaml` (o usa aceleración HEVC/software según el kernel de RPi OS).

---

### Paso 3B: Despliegue Alternativo Ultra-Ligero con Podman (`podman kube play`)

Si prefieres prescindir de K3s y ejecutar el manifiesto consolidado directamente con **Podman**:

```bash
# 1. Construye las apps personalizadas en el almacenamiento local de Podman
./scripts/build-custom-apps.sh --platform linux/arm64

# 2. Arranca el Pod completo con todos los servicios (sin conflictos de puertos)
podman kube play k8s/podman-compatible/media-pod.yaml

# 3. Verifica estado y logs
podman pod ps
podman ps --pod

# 4. (Opcional) Persistir al reinicio con systemd (Podman Quadlet)
# Copia media-pod.yaml a /etc/containers/systemd/media-pod.yaml y crea
# /etc/containers/systemd/homelab-media.kube apuntando a Yaml=media-pod.yaml
```

Puertos directos en modo Podman:
- Portal Homepage: `:3000` · **Portal Pepflix: `:8088`** · Jellyfin: `:8096` · Jellyseerr: `:5055` · Navidrome: `:4533` · Threadfin: `:34400`
- Universal Player PWA: `:8085` · Centro Educativo: `:8000`
- Prowlarr: `:9696` · Radarr: `:7878` · Sonarr: `:8989` · Lidarr: `:8686` · Bazarr: `:6767` · qBittorrent: `:8080`

---

### Paso 4: Configuración DNS Local (`*.media.local`)

En **Pi-hole** / **AdGuard Home** (o en el archivo `/etc/hosts` de tus equipos cliente), apunta los subdominios a la IP de `rpi-master` (`192.168.1.50`):

```text
192.168.1.50  media.local portal.media.local pepflix.media.local family.media.local jellyfin.media.local jellyseerr.media.local music.media.local tv.media.local player.media.local edu.media.local prowlarr.media.local sonarr.media.local radarr.media.local lidarr.media.local bazarr.media.local downloads.media.local
```

Abre el portal centralizado en tu navegador: **`http://portal.media.local`** (o `http://media.local`).

---

## 4. Configuración del Pipeline de Automatización (`Prowlarr -> *arr -> Jellyfin`)

### 4.1 Configurar qBittorrent (Hardlinks TRaSH Guides)
1. Obtén la contraseña temporal del primer arranque:
   ```bash
   kubectl -n homelab-media logs deploy/qbittorrent | grep -i password
   ```
2. Entra en `http://downloads.media.local` y cambia la contraseña en **Opciones → Interfaz Web**.
3. En **Opciones → Descargas**:
   - **Modo de gestión de torrents por defecto:** `Automático`
   - **Ruta de guardado por defecto:** `/data/torrents`
   - **Mantener los torrents incompletos en:** `/data/torrents/incomplete`
4. Crea las categorías exactas en el panel izquierdo:
   - `movies` → `/data/torrents/movies`
   - `tv` → `/data/torrents/tv`
   - `music` → `/data/torrents/music`
   - `documentaries` → `/data/torrents/documentaries`
5. (Opcional) Añade trackers públicos filtrados a qBittorrent (no a Prowlarr):
   ```bash
   ./scripts/sync-public-trackers.sh                    # simulación
   ./scripts/sync-public-trackers.sh --apply            # pide la contraseña de qBittorrent
   ```

### 4.2 Configurar Rutas Raíz, Hardlinks y Recycle Bin en Radarr, Sonarr y Lidarr
En cada servicio (`radarr.media.local`, `sonarr.media.local`, `lidarr.media.local`):

1. **Settings → Media Management** (activa *Show Advanced*):
   - Marca **Use Hardlinks instead of Copy** (`✓`).
   - **Recycling Bin:**
     - Radarr: `/data/recycle_bin/movies`
     - Sonarr: `/data/recycle_bin/tv`
     - Lidarr: `/data/recycle_bin/music`
   - **Root Folders:**
     - Radarr: `/data/media/movies` (y opcionalmente `/data/media/documentaries`)
     - Sonarr: `/data/media/tv`
     - Lidarr: `/data/media/music`
2. **Settings → Download Clients → + → qBittorrent:**
   - **Host:** `qbittorrent.homelab-media.svc.cluster.local` *(en modo Podman: `127.0.0.1`)*
   - **Port:** `8080`
   - **Username / Password:** tus credenciales de qBittorrent.
   - **Category:** `movies` (Radarr) / `tv` (Sonarr) / `music` (Lidarr).
   - **Completed Download Handling → Remove Completed:** **Desactivado** si deseas seguir compartiendo (seeding) sin romper el hardlink.

### 4.3 Conectar Prowlarr con Sonarr, Radarr y Lidarr

> **Importante — indexers ≠ trackers:** Prowlarr gestiona **indexers** (buscadores). La lista `ngosang/trackerslist` son **trackers** y se configura en **qBittorrent**, no en Prowlarr. Para el detalle técnico, legal y de seguridad consulta [`docs/INDEXERS-Y-TRACKERS.md`](docs/INDEXERS-Y-TRACKERS.md). No integres indexers de piratería (1337x, EZTV, YTS, Nyaa, RuTracker, The Pirate Bay, DonTorrent, MejorTorrent, EliteTorrent, DivxTotal, Cinecalidad, etc.) para contenido protegido.

1. Abre **`http://prowlarr.media.local`**.
2. Añade tus **indexers abiertos y legales** en **Indexers → + Add Indexer** (por ejemplo: *Internet Archive*, *Academic Torrents*, *LinuxTracker*, *Public Domain Torrents* o feeds RSS legales).
3. Copia la **API Key** de cada servicio desde `Settings → General → Security` en Sonarr, Radarr y Lidarr.
4. En **Prowlarr → Settings → Apps → +** añade cada aplicación con las URLs internas del clúster:

| Aplicación | Sync Level | Prowlarr Server | Application Server (K3s) | Application Server (Podman) |
|---|---|---|---|---|
| **Radarr** | `Full Sync` | `http://prowlarr.homelab-media.svc.cluster.local:9696` | `http://radarr.homelab-media.svc.cluster.local:7878` | `http://127.0.0.1:7878` |
| **Sonarr** | `Full Sync` | `http://prowlarr.homelab-media.svc.cluster.local:9696` | `http://sonarr.homelab-media.svc.cluster.local:8989` | `http://127.0.0.1:8989` |
| **Lidarr** | `Full Sync` | `http://prowlarr.homelab-media.svc.cluster.local:9696` | `http://lidarr.homelab-media.svc.cluster.local:8686` | `http://127.0.0.1:8686` |

5. Pulsa **Test** y **Save** en cada una, y finalmente haz clic en **Sync App Indexers**. Prowlarr sincronizará automáticamente todos los indexers hacia Sonarr, Radarr y Lidarr.

### 4.4 Conectar Bazarr con Sonarr y Radarr (Subtítulos Automáticos)
En **`http://bazarr.media.local`**:
1. **Settings → Sonarr:** habilita, host `sonarr.homelab-media.svc.cluster.local`, puerto `8989`, pega su API Key.
2. **Settings → Radarr:** habilita, host `radarr.homelab-media.svc.cluster.local`, puerto `7878`, pega su API Key.
3. **Settings → Languages:** crea un perfil con `Spanish` y `English` y añade proveedores gratuitos en **Settings → Providers** (ej. OpenSubtitles / Podnapisi).

### 4.5 Enlazar la Salida de Radarr / Sonarr / Lidarr con Jellyfin mediante Webhooks
Para que Jellyfin actualice su biblioteca en el instante en que un archivo es enlazado por `*arr` (sin esperar al escaneo programado):

1. Abre **`http://jellyfin.media.local`** → **Panel de control (Dashboard) → Claves API (API Keys) → +**.
2. Crea una clave llamada `Arr-Automation` y cópiala.
3. Configura la notificación en **Radarr**, **Sonarr** y **Lidarr**:
   - Ve a **Settings → Connect → +**.
   - **Opción recomendada (Integración nativa Emby / Jellyfin):**
     - Selecciona **Emby / Jellyfin**.
     - **Notification Triggers:** marca `On Import`, `On Upgrade`, `On Rename`.
     - **Host:** `jellyfin.homelab-media.svc.cluster.local` *(en Podman: `127.0.0.1`)*
     - **Port:** `8096`
     - **API Key:** pega la clave `Arr-Automation`.
     - Marca **Update Library (`✓`)**.
     - Pulsa **Test** y **Save**.
   - **Opción alternativa vía Webhook HTTP genérico:**
     - En **Settings → Connect → + → Webhook**, apunta a `http://jellyfin.homelab-media.svc.cluster.local:8096/Library/Refresh?api_key=<TU_API_KEY>` con método `POST` en el evento `On Import`.

---

## 5. Configuración de Jellyfin, Navidrome y Threadfin (FAST / Live TV)

### Jellyfin (Aceleración Hardware RPi y Bibliotecas RO)
1. En el asistente de **`http://jellyfin.media.local`**, añade tus bibliotecas apuntando a `/media/movies`, `/media/tv`, `/media/documentaries` y `/media/personal_videos` (todas protegidas en modo solo lectura).
2. Activa la aceleración hardware en **Panel → Reproducción → Transcodificación**:
   - **Aceleración por hardware:** `Video4Linux2 (V4L2)` *(en Raspberry Pi 4 con `/dev/video10-12`)*.
   - Prioriza siempre **Reproducción Directa (Direct Play)** para minimizar la carga de CPU ARM.
3. Configura metadatos oficiales en cada biblioteca: **TheMovieDb (TMDb)** y **TheTVDB** (películas/series), **MusicBrainz** (música).

### Threadfin → Jellyfin Live TV (Canales Gratuitos y Legales)
1. Abre **`http://tv.media.local`** (consulta las URLs de referencia montadas en el ConfigMap `threadfin-legal-sources`: **TDTChannels**, **Pluto TV** y **RTVE Play**).
2. Añade las listas M3U en **Playlist** y las guías EPG en **XMLTV**, y activa los canales deseados en **Mapping**.
3. En **Jellyfin → Panel → TV en directo**:
   - **Dispositivos sintonizadores (+) → Sintonizador M3U:**
     `http://threadfin.homelab-media.svc.cluster.local:34400/m3u/threadfin.m3u`
   - **Proveedores de guía (+) → XMLTV:**
     `http://threadfin.homelab-media.svc.cluster.local:34400/xmltv/threadfin.xml`

### Navidrome (Música, Radios Libres y Podcasts)
- Accede a **`http://music.media.local`** y crea tu cuenta administrador.
- Navidrome indexa `/mnt/storage/media/music` en modo solo lectura e importa automáticamente las listas `.m3u` de `/mnt/storage/media/music/playlists/` (incluyendo `radios-libres.m3u` y `podcasts-abiertos.m3u` creadas por `setup-nodes.sh`).
- Compatible con clientes móviles Subsonic/OpenSubsonic (Symfonium, Tempo, Amperfy, Substreamer).

---

## 6. Portal Homepage (Activación de Widgets) y Escáner Anti-Duplicados

### Activar Widgets API en Homepage
Una vez generadas tus API Keys, actualiza el Secret de Kubernetes y reinicia Homepage:

```bash
kubectl -n homelab-media create secret generic homepage-secrets \
  --from-literal=HOMEPAGE_VAR_JELLYFIN_API_KEY="<KEY>" \
  --from-literal=HOMEPAGE_VAR_PROWLARR_API_KEY="<KEY>" \
  --from-literal=HOMEPAGE_VAR_SONARR_API_KEY="<KEY>" \
  --from-literal=HOMEPAGE_VAR_RADARR_API_KEY="<KEY>" \
  --from-literal=HOMEPAGE_VAR_LIDARR_API_KEY="<KEY>" \
  --from-literal=HOMEPAGE_VAR_BAZARR_API_KEY="<KEY>" \
  --from-literal=HOMEPAGE_VAR_QBIT_USER="admin" \
  --from-literal=HOMEPAGE_VAR_QBIT_PASS="<PASSWORD>" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n homelab-media rollout restart deploy/homepage
```

### Portal familiar Pepflix (experiencia para tu padre)

El Módulo 8 publica una landing sencilla en `http://pepflix.media.local` (o `http://localhost:8088` en Docker Compose). Solo muestra accesos de familia:

- **Jellyfin** para ver películas, series y TV.
- **Jellyseerr** para pedir contenido.
- **Edu Catalog**, **Threadfin** y **Navidrome**.
- Enlaces a fuentes legales (Internet Archive, NASA+, MIT OCW, Wikimedia, RTVE Play, TDTChannels).

No muestra Prowlarr, qBittorrent, Sonarr, Radarr, Lidarr ni Bazarr. El enlace de **Administración** del pie lleva al portal técnico (`portal.media.local`) y debe quedar solo para ti. Jellyseerr se publica en `jellyseerr.media.local` (Módulo 8) para que las peticiones de la familia lleguen a Sonarr/Radarr.

Recomendaciones para la cuenta de tu padre:

1. El usuario de Jellyfin ya creado es `Daniel` (sin permisos de administrador).
2. Limita las bibliotecas y la clasificación por edad.
3. Crea un usuario en Jellyseerr con permisos de petición, no de administración.
4. Deja el usuario administrador de Jellyfin con PIN.
5. No compartas las API keys ni el enlace de administración.

Guías ya creadas para este caso:

- [`docs/MANUAL-PEPFLIX-PAPA.md`](docs/MANUAL-PEPFLIX-PAPA.md) — manual imprimible y sin tecnicismos para tu padre: cómo moverse por la interfaz y ver contenido.
- [`docs/INSTALACION-PEPFLIX-TV.md`](docs/INSTALACION-PEPFLIX-TV.md) — cómo dejar la app de Jellyfin en la TV, con sección específica para **Samsung Tizen** y alternativas (Android TV, Fire TV, LG/Apple TV o stick HDMI).
- [`docs/ADMIN-CATALOGO-E-INDEXADORES.md`](docs/ADMIN-CATALOGO-E-INDEXADORES.md) — cómo ampliar el catálogo legal y añadir indexadores legales a Prowlarr por URL.

Para la TV, la dirección fija es `http://192.168.100.46:8096` y el servidor se llama **Pepflix**. Reserva esa IP en el router para que no cambie.

### Catálogo legal e indexadores

Pepflix usa contenido de **dominio público** de Internet Archive. Para ampliar el
catálogo:

```bash
# Simular
./scripts/fetch-legal-catalog.py --dry-run --type all --limit 10

# Descargar un lote
./scripts/fetch-legal-catalog.py --apply --type all \
  --limit 20 --scan-limit 100 --max-size-mb 800 --prefer-small
```

Para añadir un indexador legal a Prowlarr usando la URL de su interfaz:

```bash
./scripts/add-legal-indexer.py --url https://archive.org/ --apply
./scripts/add-legal-indexer.py --list
```

Prowlarr solo acepta definiciones que ya trae instaladas. El script valida el
dominio contra una lista blanca legal y no integra indexadores de piratería.
Detalles en [`docs/ADMIN-CATALOGO-E-INDEXADORES.md`](docs/ADMIN-CATALOGO-E-INDEXADORES.md).

### Ejecutar y Consultar el Escáner Anti-Duplicados (Czkawka CLI)
El `CronJob` se ejecuta automáticamente cada domingo a las `04:00` en modo **solo lectura** (sin borrar ningún archivo). Para lanzar una ejecución manual inmediata:

```bash
kubectl -n homelab-media create job --from=cronjob/czkawka-duplicate-scanner manual-dup-scan
kubectl -n homelab-media logs -f job/manual-dup-scan
```

Los informes quedan guardados en:
- `/mnt/storage/appdata/reports/duplicates-latest.json`
- `/mnt/storage/appdata/reports/duplicates-latest.html`

---

## 7. Verificación de Hardlinks y Diagnóstico Rápido

Comprueba que un archivo importado por Radarr/Sonarr comparte **exactamente el mismo número de inodo** y contador de enlaces (`Links: 2`) entre `torrents/` y `media/`:

```bash
stat /mnt/storage/torrents/movies/<archivo>.mkv /mnt/storage/media/movies/<carpeta>/<archivo>.mkv
```

Comandos útiles de diagnóstico en el clúster:
```bash
# Consumo de CPU/RAM en ambas Raspberry Pi
kubectl top nodes
kubectl -n homelab-media top pods

# Verificar rutas Traefik Ingress
kubectl -n homelab-media get ingress

# Verificar montaje Read-Only en Jellyfin (debe devolver "Read-only file system")
kubectl -n homelab-media exec deploy/jellyfin -- touch /media/.test_ro
```
