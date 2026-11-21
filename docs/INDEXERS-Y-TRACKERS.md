# Indexers, trackers y seguridad

Guía técnica para el stack `homelab-media-stack` / `pepflix`.

## 1. Corrección conceptual importante

En este stack hay dos piezas distintas que suelen confundirse:

| Pieza | Qué hace | Dónde se configura |
|---|---|---|
| **Indexer** | Busca y cataloga releases: películas, series, música, anime, documentales. Devuelve título, tamaño, seeders, calidad y un enlace `.torrent` o magnet. | **Prowlarr** |
| **Tracker** | Coordina peers de un torrent concreto. Recibe `announce` y devuelve una lista de IPs/puertos de otros peers. No aloja el contenido ni sirve para buscar. | **qBittorrent** |

Por tanto:

- `1337x`, `EZTV`, `YTS`, `Nyaa`, `RuTracker`, `The Pirate Bay`, `DonTorrent`, `MejorTorrent`, `EliteTorrent`, `DivxTotal` y `Cinecalidad` son **indexers**, no trackers.
- `ngosang/trackerslist` **no se añade a Prowlarr**. Se añade a **qBittorrent** (o al cliente BitTorrent que uses).
- Prowlarr no descarga contenido. Solo busca, normaliza resultados y los pasa a Sonarr/Radarr/Lidarr.
- qBittorrent no busca contenido. Solo descarga el torrent que le entrega el `*arr`.

## 2. Cómo funciona BitTorrent por dentro

### 2.1 Magnet, info-hash y announce

Un magnet link contiene, entre otras cosas:

```text
magnet:?xt=urn:btih:<INFO_HASH>&dn=<NOMBRE>&tr=<TRACKER_1>&tr=<TRACKER_2>
```

- `xt=urn:btih:...` identifica el torrent mediante el **info-hash** (SHA-1/SHA-256 del diccionario `info` del `.torrent`).
- `dn` es el nombre visible.
- `tr` es un tracker anunciado.

Cuando qBittorrent empieza un torrent, envía un `announce` a cada tracker:

```text
GET /announce?info_hash=...&peer_id=...&port=6881&uploaded=0&downloaded=0&left=...&event=started
```

El tracker responde con una lista de peers (IP:puerto) y un intervalo de actualización. A partir de ahí, los peers se conectan entre sí y se intercambian bloques.

### 2.2 HTTP, UDP, WebSocket, I2P y Yggdrasil

- **HTTP/HTTPS**: el anuncio va por HTTP. HTTPS protege el announce, pero no el tráfico entre peers.
- **UDP**: protocolo binario de BitTorrent (BEP 15). Es el más habitual en trackers públicos.
- **WebSocket (`ws`/`wss`)**: usado por WebTorrent; pocos clientes clásicos lo soportan.
- **I2P**: requiere router I2P y cliente compatible.
- **Yggdrasil**: requiere router Yggdrasil.

### 2.3 DHT y PEX

Un torrent puede funcionar sin tracker:

- **DHT** (Mainline DHT): tabla distribuida que permite encontrar peers por info-hash.
- **PEX** (Peer Exchange): los peers se pasan listas de otros peers.

Por eso añadir trackers no siempre es necesario. Los trackers ayudan sobre todo con torrents antiguos, poco poblados o cuando DHT/PEX está desactivado.

### 2.4 Trackers públicos y privados

- **Público**: cualquiera puede anunciarse. No hay autenticación. Puede haber peers maliciosos, fake seeds y logging de IPs.
- **Privado**: requiere una **passkey** o cuenta. El tracker sabe exactamente qué usuario anuncia. Suele tener reglas de ratio y contenido.

## 3. Cómo funciona un indexer por dentro

Un indexer es un buscador. Puede exponer:

- **API Torznab/Newznab**: XML/JSON normalizado. Es lo que usan Prowlarr, Sonarr, Radarr y Lidarr.
- **HTML scraping**: Prowlarr usa definiciones YAML/Cardigann para extraer resultados de la web.
- **RSS**: algunos indexers ofrecen feeds por categoría o búsqueda.

Flujo típico:

```text
Sonarr/Radarr
    │  GET /api/v1/search?query=...
    ▼
Prowlarr
    │  consulta en paralelo los indexers habilitados
    │  normaliza título, tamaño, seeders, categoría, enlace
    ▼
Sonarr/Radarr
    │  aplica perfil de calidad, idioma, puntuación, tamaño
    │  elige el mejor release
    ▼
qBittorrent
    │  recibe magnet/.torrent y descarga
    ▼
Sonarr/Radarr
    │  importa por hardlink a /data/media/...
    ▼
Jellyfin
    │  detecta el nuevo archivo y actualiza la biblioteca
```

Prowlarr también sincroniza indexers hacia las apps (`Settings → Apps → Sync App Indexers`). Así no hay que repetir la configuración en cada `*arr`.

## 4. Qué es `ngosang/trackerslist`

Es una lista de **trackers públicos** mantenida automáticamente:

- `trackers_best.txt`: los 20 mejores por popularidad y latencia. **Recomendado.**
- `trackers_all.txt`: todos los trackers válidos.
- `trackers_all_udp.txt`, `trackers_all_https.txt`, `trackers_all_http.txt`: filtrados por protocolo.
- `trackers_all_ip.txt`: variante con IPs en vez de dominios, para problemas de DNS.
- `trackers_all_ws.txt`: WebSocket/WebTorrent.
- `trackers_all_i2p.txt`, `trackers_all_yggdrasil.txt`: redes alternativas.
- `blacklist.txt`: trackers con malware detectado, fallos, fake seeds o contenido registrado. **No los uses.**

### 4.1 Cómo usarla en qBittorrent

qBittorrent permite añadir trackers automáticamente a descargas nuevas:

`Opciones → BitTorrent → Añadir estos trackers automáticamente a las descargas nuevas`

Pega la lista separada por líneas. Para hacerlo por API:

```bash
cd /home/daniel/.gemini/antigravity-ide/scratch/homelab-media-stack

# Simulación: descarga, filtra blacklist y muestra
./scripts/sync-public-trackers.sh

# Solo los 20 mejores
./scripts/sync-public-trackers.sh --max 20

# Aplicar a qBittorrent local (pide la contraseña de forma interactiva)
./scripts/sync-public-trackers.sh --apply

# qBittorrent en el clúster o en otro host
QBIT_URL='http://192.168.1.50:8080' ./scripts/sync-public-trackers.sh --apply
```

El script:

1. Descarga la lista.
2. Elimina comentarios, duplicados y trackers de `blacklist.txt`.
3. Por defecto descarta `http://` y deja `udp://`, `https://` y `wss://`.
4. Opcionalmente aplica `add_trackers` y `add_trackers_enabled` vía API de qBittorrent.

### 4.2 Lo que no debes hacer

- No pegues `trackers_all.txt` entero sin filtrar. Más trackers no significa mejor rendimiento; aumentan el ruido, los announces y la superficie de exposición.
- No uses listas de IPs salvo que tengas un problema real de DNS.
- No mezcles trackers de redes que no usas (I2P, Yggdrasil) si no tienes el router correspondiente.
- No confíes en un tracker solo porque aparezca en una lista: la lista se actualiza, pero un tracker puede cambiar de dueño o comportamiento.

## 5. Legalidad: lo más importante

Los trackers públicos son infraestructura neutra. Se usan tanto para distribuciones Linux y contenido de dominio público como para obras protegidas.

Los indexers que mencionas (`1337x`, `EZTV`, `YTS`, `Nyaa`, `RuTracker`, `The Pirate Bay`, `DonTorrent`, `MejorTorrent`, `EliteTorrent`, `DivxTotal`, `Cinecalidad`) distribuyen o enlazan mayoritariamente obras protegidas por derechos de autor sin autorización. **No puedo ayudarte a integrarlos para descargar o distribuir esas obras.**

Sí puedo ayudarte con:

- Indexers de **dominio público, Creative Commons, acceso abierto o contenido autorizado**.
- Distribuciones Linux y software libre.
- Archivos de música con licencias abiertas.
- Documentales y material educativo de NASA, Wikimedia, Internet Archive, MIT OCW, etc.
- La arquitectura, seguridad y automatización del stack.

### 5.1 Fuentes legales recomendadas

| Fuente | Tipo | Nota |
|---|---|---|
| Internet Archive | Vídeo, audio, textos | Verifica la licencia de cada ítem; hay contenido subido por usuarios. |
| Prelinger Archives | Documentales | Dominio público. |
| NASA / NASA+ | Vídeo | Dominio público, salvo marcas y material de terceros. |
| Wikimedia Commons | Vídeo/audio | CC BY-SA o dominio público. |
| MIT OpenCourseWare | Cursos | CC BY-NC-SA. |
| Blender Open Movies | Animación | CC BY. |
| Academic Torrents | Datasets/papers | Contenido académico; revisa licencia. |
| LinuxTracker | ISOs Linux | Distribuciones autorizadas. |
| etree.org | Conciertos | Grabaciones con permiso de los artistas. |
| Jamendo / Free Music Archive | Música | Licencias CC. |
| Ubuntu/Debian/Fedora/Linux Mint/Arch | ISOs | Torrents oficiales. |
| Pluto TV / RTVE Play / TDTChannels | FAST/Live TV | Streaming gratuito con sus propios términos. |

### 5.2 Riesgo legal real

- El **tracker** no determina la legalidad; el **contenido** sí.
- Descargar y, sobre todo, **compartir** (subir) obras protegidas sin autorización puede ser ilegal en la mayoría de jurisdicciones.
- El detalle cambia por país. En España y México hay diferencias entre copia privada, comunicación pública y distribución. Consulta a un abogado si tienes dudas.
- Tu ISP puede ver conexiones BitTorrent y recibir avisos de titulares. Una VPN no legaliza la actividad; solo cambia quién ve tu IP.

## 6. Modelo de amenazas para este stack

### 6.1 Indexers no confiables

Un indexer puede devolver:

- Títulos y metadatos falsos.
- Enlaces a archivos maliciosos (`.exe`, `.scr`, `.lnk`, macros, scripts).
- `.torrent` con rutas `../` o nombres manipulados.
- Trackers maliciosos o anuncios falsos.
- Resultados con seeders falsos para atraer descargas.
- Publicidad, popups, redirecciones y phishing.

Mitigaciones:

- Usa solo indexers de confianza y, si es posible, con API.
- No ejecutes archivos descargados; usa Jellyfin para reproducir.
- Filtra extensiones no multimedia en Sonarr/Radarr.
- Mantén qBittorrent actualizado.
- No abras `.torrent` de fuentes desconocidas en el navegador.
- Usa un usuario sin privilegios para los contenedores.

### 6.2 SSRF en Prowlarr

Prowlarr hace peticiones HTTP a las URLs de los indexers. Si añades un indexer malicioso con una URL como `http://radarr.homelab-media.svc.cluster.local:7878`, Prowlarr podría intentar acceder a servicios internos.

Mitigaciones:

- No añadas indexers que no conozcas.
- Aplica una `NetworkPolicy` de egreso: Prowlarr solo debe salir a Internet y a las APIs de Sonarr/Radarr/Lidarr.
- No expongas Prowlarr a Internet.
- Revisa logs de Prowlarr y de Traefik.

### 6.3 Exposición de paneles

En este repo, el Ingress publica **todos** los servicios en `*.media.local`, incluidos Prowlarr, Sonarr, Radarr, Lidarr, Bazarr y qBittorrent. Aunque sea una red local, cualquier dispositivo comprometido puede alcanzarlos.

Mitigaciones:

- Cambia la contraseña de qBittorrent en el primer arranque.
- Activa autenticación en Prowlarr, Sonarr, Radarr, Lidarr y Bazarr.
- Activa autenticación en Threadfin (en la configuración local aparece desactivada).
- Publica solo Jellyfin y el portal a la familia; deja los paneles de administración en una red/VLAN de administración.
- Añade TLS en Traefik (`websecure`) o usa un proxy con HTTPS.
- No hagas port forwarding de `8080`, `9696`, `8989`, `7878`, `8686`, `6767` ni `6881` a Internet.
- Para acceso remoto, usa WireGuard/Tailscale, no expongas los puertos.

### 6.4 Secretos y API keys

- `local-storage/` está en `.gitignore`, pero contiene bases de datos, API keys y configuraciones reales. No lo compartas ni lo subas.
- Las API keys de `*arr`, Bazarr y qBittorrent dan control total sobre descargas y biblioteca. Trátalas como contraseñas.
- `k8s/base/portal-homepage.yaml` incluye un `Secret` con placeholders. Cámbialos y no los commitees con valores reales.
- Para producción, usa SOPS, Sealed Secrets o External Secrets, no `stringData` en Git.
- Rota las claves si alguna vez se han expuesto en un chat, captura o repositorio.

### 6.5 Supply chain de contenedores

El repo usa `:latest` en varias imágenes. Eso facilita actualizaciones, pero también introduce cambios no revisados.

Mitigaciones:

- Fija versiones o digests (`@sha256:...`).
- Usa imágenes oficiales o de confianza.
- Escanea imágenes con Trivy/Grype.
- Revisa los cambios antes de actualizar.
- No ejecutes contenedores como root si la imagen lo permite.
- Añade `securityContext`: `runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `readOnlyRootFilesystem` cuando sea posible.

### 6.6 Malware en archivos multimedia y subtítulos

- Los vídeos no suelen ejecutarse, pero los reproductores y códecs tienen vulnerabilidades.
- Los subtítulos `.srt`/`.ass` pueden explotar fallos de reproductores o contener enlaces.
- Los archivos `.zip`, `.rar`, `.iso` y ejecutables son señales de alarma.
- Mantén Jellyfin, el navegador y el sistema actualizados.
- No instales códecs de dudosa procedencia.

### 6.7 Privacidad

- Un tracker público ve tu IP y tu info-hash.
- DHT y PEX también exponen tu IP a otros peers.
- El cifrado de transporte de BitTorrent ofusca el protocolo, pero no te hace anónimo.
- Una VPN cambia tu IP de salida, pero el proveedor de VPN puede ver tu tráfico y debe permitir P2P.
- No uses trackers públicos para contenido sensible o privado.

### 6.8 Ransomware y borrado

- qBittorrent y los `*arr` tienen permisos de escritura sobre `/data`.
- Un contenedor comprometido o una configuración errónea puede borrar o cifrar la biblioteca.
- El repo ya aplica `recycle_bin` y montajes de solo lectura en Jellyfin/Navidrome. Mantenlo.
- Haz copias de seguridad de `appdata/` y de la biblioteca. Prueba la restauración.
- No ejecutes qBittorrent como root.

## 7. Checklist de hardening para este repo

### 7.1 Inmediato

- [ ] Cambiar la contraseña de qBittorrent.
- [ ] Activar autenticación en Prowlarr, Sonarr, Radarr, Lidarr y Bazarr.
- [ ] Activar autenticación en Threadfin.
- [ ] Revisar que `local-storage/` no esté en Git.
- [ ] No exponer los paneles a Internet.
- [ ] Verificar que el Ingress solo publica lo necesario.

### 7.2 Red

- [ ] Añadir `NetworkPolicy` con denegación por defecto.
- [ ] Permitir DNS y solo las conexiones necesarias.
- [ ] Prowlarr: egreso a Internet y a las APIs de los `*arr`.
- [ ] qBittorrent: egreso a Internet y a los trackers; sin acceso a la red de administración.
- [ ] Jellyfin: ingreso desde la LAN/VLAN de familia.
- [ ] Separar la VLAN de administración de la VLAN de familia/IoT.

### 7.3 Kubernetes

- [ ] Añadir `securityContext` a todos los Deployments.
- [ ] `runAsNonRoot: true` y `runAsUser: 1000` cuando la imagen lo permita.
- [ ] `allowPrivilegeEscalation: false`.
- [ ] `capabilities.drop: ["ALL"]`.
- [ ] `readOnlyRootFilesystem: true` con `emptyDir` para temporales.
- [ ] Fijar imágenes por digest.
- [ ] Añadir `PodDisruptionBudget` si hay más de una réplica.
- [ ] Añadir backups de `appdata` y de la biblioteca.
- [ ] Añadir monitorización (Uptime Kuma, Prometheus/Grafana, Loki).
- [ ] Revisar el RBAC de Homepage: solo lectura, pero es cluster-wide.

### 7.4 Cambios de hardening ya incluidos en el repo

- `k8s/base/namespace.yaml`: Pod Security Standards en `baseline` (audit/warn en `restricted`).
- `k8s/base/network-policy.yaml`: denegación por defecto, DNS, ingress desde Traefik, tráfico interno del namespace, salida a Internet sin rangos privados y entrada P2P a qBittorrent en `6881/tcp` y `6881/udp`.
- `k8s/base/family-portal.yaml`: portal familiar sin acceso a paneles de administración, ejecutado sin privilegios y con `seccompProfile: RuntimeDefault`.
- `k8s/base/jellyseerr.yaml`: peticiones separadas de la administración.

Antes de aplicar en la Raspberry Pi, revisa dos casos:

1. Si Threadfin necesita acceder a una fuente IPTV en tu LAN, añade una regla de egreso a esa IP/puerto.
2. Si cambias el PV de `hostPath` a NFS nativo, añade egreso al servidor NFS (`192.168.1.50:2049/tcp`) porque la política bloquea rangos privados.
3. La política `allow-kubernetes-api-egress` asume el CIDR de servicio por defecto de K3s (`10.43.0.1/32`). Si tu clúster usa otro CIDR, ajusta esa IP para que el widget de Kubernetes de Homepage siga funcionando.

Validación y despliegue:

```bash
kubectl kustomize k8s/base > /dev/null && echo "Kustomize OK"
kubectl apply -k k8s/base
kubectl -n homelab-media get networkpolicy
kubectl -n homelab-media get pods
```

Si algo deja de responder, revisa primero la NetworkPolicy y elimina `allow-internet-egress` o añade la excepción concreta.

### 7.5 Aplicaciones

- [ ] Prowlarr: solo indexers legales y de confianza.
- [ ] qBittorrent: trackers de `trackers_best`, no `trackers_all` sin filtrar.
- [ ] Sonarr/Radarr: perfiles de calidad, tamaños máximos y listas de bloqueo.
- [ ] Bazarr: proveedores de subtítulos de confianza.
- [ ] Jellyfin: usuarios separados, control parental y sin acceso de administrador para la familia.
- [ ] Homepage: no mostrar enlaces de administración a los usuarios familiares.

## 8. Plataforma para tu padre: diseño recomendado

Objetivo: que tu padre vea contenido legal de forma sencilla, sin ver indexers, trackers, API keys ni paneles de administración.

### 8.1 Arquitectura

```text
Familia (TV, tablet, móvil)
        │
        ▼
Jellyfin  ──►  Biblioteca /data/media (solo lectura)
        │
        ├──► Jellyseerr (solicitudes de películas/series)
        ├──► Homepage "Pepflix" (portal simple)
        └──► Edu Catalog (documentales y cursos)

Administración (solo LAN/VPN)
        │
        ├──► Prowlarr (indexers legales)
        ├──► Sonarr / Radarr / Lidarr
        ├──► qBittorrent
        └──► Bazarr
```

### 8.2 Roles

- **Familia**: solo Jellyfin, Jellyseerr y el portal. Sin acceso a Prowlarr, qBittorrent ni `*arr`.
- **Administrador (tú)**: Prowlarr, qBittorrent, `*arr`, Bazarr, backups.
- **Invitados**: usuario de Jellyfin con biblioteca limitada y control parental.

### 8.3 Experiencia "Pepflix"

- Nombre y logo "Pepflix" en Homepage y Jellyfin.
- Botones grandes: "Ver películas", "Ver series", "Documentales", "Pedir algo".
- Idioma por defecto: español; subtítulos en español.
- Favoritos y "continuar viendo" de Jellyfin.
- Sección "Novedades" con lo último importado.
- Sección "TV gratis" con Pluto TV, RTVE Play y TDTChannels.
- Sección "Educación" con Edu Catalog.
- Sin enlaces a indexers ni a descargas.

### 8.4 Flujo de solicitudes

1. Tu padre busca en Jellyseerr.
2. Jellyseerr consulta Sonarr/Radarr.
3. Si no existe, Sonarr/Radarr buscan en Prowlarr.
4. Prowlarr solo consulta indexers legales.
5. qBittorrent descarga.
6. Sonarr/Radarr importan por hardlink.
7. Jellyfin actualiza la biblioteca.
8. Tu padre recibe la notificación en Jellyseerr.

### 8.5 Control parental

- Crea usuarios separados en Jellyfin.
- Limita el acceso a bibliotecas por usuario.
- Configura clasificación por edad.
- Usa un PIN para el usuario administrador.
- Bloquea dominios de indexers/adultos en Pi-hole/AdGuard para la VLAN de familia.
- No des credenciales de administrador.

### 8.6 Backups

- `appdata/` de Jellyfin, Sonarr, Radarr, Lidarr, Prowlarr, Bazarr y qBittorrent.
- Base de datos de Jellyseerr y Edu Catalog.
- Configuración de Homepage.
- Biblioteca de medios (o al menos un índice de archivos).
- Prueba una restauración completa antes de confiar en el backup.

## 9. Configuración de Prowlarr con fuentes legales

1. Abre `http://prowlarr.media.local`.
2. Activa autenticación en `Settings → General → Security`.
3. En `Indexers → Add Indexer`, busca fuentes legales:
   - Academic Torrents.
   - LinuxTracker.
   - Internet Archive (si tu versión de Prowlarr lo incluye; si no, usa RSS/Torznab).
   - Trackers de distribuciones Linux.
4. Evita indexers generalistas que alojan obras protegidas.
5. En `Settings → Apps`, añade Sonarr, Radarr y Lidarr con sus API keys.
6. Pulsa `Test`, `Save` y `Sync App Indexers`.
7. En Sonarr/Radarr, revisa que los indexers aparezcan y que las categorías sean correctas.
8. Haz una búsqueda de prueba con contenido de dominio público.

### Añadir un indexador legal por URL

Prowlarr solo permite definiciones que ya trae instaladas. El script
`scripts/add-legal-indexer.py` busca la definición correspondiente a una URL y
la añade solo si el dominio está en la lista blanca legal:

```bash
./scripts/add-legal-indexer.py --list
./scripts/add-legal-indexer.py --url https://archive.org/ --apply
```

En esta instalación ya están añadidos **Internet Archive** y **LinuxTracker**, y
Prowlarr los sincroniza con Radarr y Sonarr. No añadas indexadores de piratería.

## 10. Configuración de qBittorrent

1. Cambia la contraseña en `Opciones → Interfaz Web`.
2. En `Opciones → Descargas`:
   - Ruta por defecto: `/data/torrents`.
   - Incompletos: `/data/torrents/incomplete`.
3. Crea categorías:
   - `movies` → `/data/torrents/movies`
   - `tv` → `/data/torrents/tv`
   - `music` → `/data/torrents/music`
   - `documentaries` → `/data/torrents/documentaries`
4. En `Opciones → BitTorrent`:
   - Activa `Añadir estos trackers automáticamente a las descargas nuevas`.
   - Pega `trackers_best` filtrado, no `trackers_all` sin filtrar.
5. Desactiva `DHT` y `PEX` solo si usas trackers privados y quieres evitar fugas; para trackers públicos suelen ayudar.
6. No expongas la WebUI a Internet.

## 11. Comandos útiles

```bash
# Ver trackers válidos sin aplicar
./scripts/sync-public-trackers.sh

# Aplicar a qBittorrent local (pide la contraseña)
./scripts/sync-public-trackers.sh --apply

# Ver la configuración de qBittorrent
curl -s -b cookies.txt 'http://127.0.0.1:8080/api/v2/app/preferences' | jq '.add_trackers, .add_trackers_enabled'

# Comprobar el estado de Prowlarr
curl -s 'http://127.0.0.1:9696/ping'

# Ver logs de Prowlarr en K3s
kubectl -n homelab-media logs deploy/prowlarr --tail=100

# Ver NetworkPolicies
kubectl -n homelab-media get networkpolicy

# Ver Ingress
kubectl -n homelab-media get ingress
```

## 12. Resumen

- **Prowlarr** busca en **indexers**; **qBittorrent** usa **trackers**.
- `trackerslist` va a qBittorrent, no a Prowlarr.
- Usa `trackers_best` y filtra la blacklist.
- Los indexers de tu lista son mayoritariamente piratería; no los integres para contenido protegido.
- Para tu padre, construye una experiencia simple sobre Jellyfin + Jellyseerr + Homepage + fuentes legales.
- La seguridad no es solo “que funcione”: es autenticación, red, secretos, backups, permisos y actualizaciones.
