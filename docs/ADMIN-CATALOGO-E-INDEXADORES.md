# Pepflix — catálogo legal e indexadores

**Para el administrador** · Noviembre 2026

Esta guía explica cómo ampliar el catálogo de Pepflix usando **fuentes legales**
(dominio público y Creative Commons) y cómo añadir indexadores legales a
Prowlarr. No se integran indexadores de piratería ni contenido protegido.

---

## 1. Qué hace el catálogo automático

El script `scripts/fetch-legal-catalog.py` descarga contenido de **Internet
Archive** y lo coloca ya ordenado para Jellyfin:

- **Películas:** colección `feature_films` con licencia `publicdomain`.
- **Series:** colección `classic_tv` con licencia `publicdomain` y títulos con
  patrón `SxxExx`, `1x01`, `Ep01`, `Season 1 Episode 2`, etc.

Destinos:

- `local-storage/media/movies/<Título (Año)>/<Título (Año)>.<ext>`
- `local-storage/media/tv/<Serie>/Season NN/<Serie> - SxxExx - <Episodio>.<ext>`

El script:

- Solo acepta elementos con licencia de dominio público.
- Bloquea títulos no aptos por palabras clave.
- Evita duplicar películas si la carpeta ya tiene un vídeo.
- Permite varios episodios de la misma serie.
- Usa `curl` con reanudación si se corta la descarga.
- Por defecto **no descarga**: hay que pasar `--apply`.

---

## 2. Comandos habituales

Desde la raíz del repositorio:

```bash
# Ver qué descargaría, sin descargar nada
./scripts/fetch-legal-catalog.py --dry-run --type all --limit 10

# Descargar un lote pequeño y rápido
./scripts/fetch-legal-catalog.py --apply --type all \
  --limit 10 --scan-limit 100 --max-size-mb 400 --prefer-small

# Descargar un lote más amplio (puede tardar horas)
./scripts/fetch-legal-catalog.py --apply --type all \
  --limit 50 --scan-limit 100 --max-size-mb 800
```

Opciones útiles:

| Opción | Qué hace |
|---|---|
| `--type movie` | Solo películas |
| `--type series` | Solo series |
| `--type all` | Películas y series |
| `--limit N` | Máximo de elementos **por tipo** |
| `--scan-limit N` | Candidatos a revisar (máx. 100 por consulta) |
| `--max-size-mb N` | Tamaño máximo por archivo |
| `--prefer-small` | Prioriza archivos pequeños (más rápido) |
| `--apply` | Descarga de verdad |
| `--dry-run` | Solo simula (por defecto) |

Para dejarlo descargando por la noche:

```bash
nohup ./scripts/fetch-legal-catalog.py --apply --type all \
  --limit 100 --scan-limit 100 --max-size-mb 800 \
  > /tmp/pepflix-catalogo.log 2>&1 &
```

Puedes seguir el progreso con:

```bash
tail -f /tmp/pepflix-catalogo.log
```

Si se interrumpe, vuelve a ejecutarlo: las películas ya completas se saltan y
las descargas parciales se reanudan.

---

## 3. Añadir un indexador legal por URL

Prowlarr no acepta definiciones arbitrarias por URL: usa las definiciones que
ya trae instaladas. El script busca la definición que corresponde a la URL y la
añade solo si el dominio está en la lista blanca legal.

```bash
# Ver indexadores legales disponibles
./scripts/add-legal-indexer.py --list

# Simular
./scripts/add-legal-indexer.py --url https://archive.org/

# Añadir de verdad
./scripts/add-legal-indexer.py --url https://archive.org/ --apply
```

Lista blanca por defecto:

- `archive.org` (Internet Archive)
- `linuxtracker.org` (LinuxTracker)

Para ampliar la lista blanca a otro indexador legal:

```bash
LEGAL_INDEXER_HOSTS=ejemplo.org ./scripts/add-legal-indexer.py \
  --url https://ejemplo.org/ --apply
```

El script usa la API key de Prowlarr desde:

1. `--api-key`
2. Variable `PROWLARR_API_KEY`
3. `local-storage/appdata/prowlarr/config/config.xml`
4. `/home/daniel/media-stack/config/prowlarr/config.xml`

Después de añadirlo, Prowlarr lo sincroniza con Radarr y Sonarr según la
configuración de **Apps**.

---

## 4. Prowlarr, Radarr y Sonarr

Interfaz de Prowlarr:

```text
http://192.168.100.46:9696
```

Comprobaciones:

- **Indexers:** deben aparecer `Internet Archive` y `LinuxTracker`.
- **Apps:** Radarr y Sonarr con `Sync Level: Full Sync`.
- En Radarr/Sonarr, el indexador aparece como `Internet Archive (Prowlarr)`.

Si añades un indexador nuevo y no aparece en Radarr/Sonarr:

1. Entra en Prowlarr → **Settings → Apps**.
2. Pulsa **Test** y luego **Save** en cada app.
3. En **Indexers**, usa **Sync** o espera a la sincronización automática.

---

## 5. Jellyfin

Interfaz:

```text
http://192.168.100.46:8096
```

Bibliotecas correctas:

| Biblioteca | Tipo | Rutas |
|---|---|---|
| `Películas` | Movies | `/media/movies`, `/media-nas/peliculas` |
| `Series` | Shows | `/media/tv`, `/media-nas/series` |
| `Documentales` | Movies | `/media/documentaries` |

Después de descargar contenido nuevo:

1. Jellyfin → **Dashboard → Libraries**.
2. Pulsa **Scan All Libraries**.
3. Comprueba que aparecen las películas y episodios.

---

## 6. Seguridad y límites

- No añadas indexadores de piratería ni contenido protegido.
- No compartas API keys, contraseñas ni el enlace de administración.
- No publiques el token de GitHub en el chat: si se expone, revócalo.
- El catálogo automático solo usa dominio público. Para otra fuente, revisa su
  licencia antes de integrarla.
- Los archivos descargados viven en `local-storage/`, que está ignorado por Git.

---

## 7. Estado actual (ejemplo)

Tras la última ejecución:

- **4 películas** en Jellyfin: *Elephants Dream*, *Tears of Steel*,
  *Charlie Chaplin Festival*, *His Girl Friday*.
- **3 series** y **6 episodios**: *The Beverly Hillbillies*,
  *The Andy Griffith Show* y *Steptoe and Son*.
- **Internet Archive** añadido a Prowlarr y sincronizado con Radarr/Sonarr.

El catálogo puede crecer ejecutando el script con límites más altos.
