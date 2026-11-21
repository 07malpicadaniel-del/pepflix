# Instalación de Pepflix en la TV

Guía para el hijo / administrador. La guía para papá está en `MANUAL-PEPFLIX-PAPA.md`.

**Caso real: TV Samsung con Tizen.** La instalación específica está en el **Caso C**. Los demás casos son alternativas por si cambiáis de TV.

Objetivo: dejar en la TV un icono que abra directamente la biblioteca, sin que papá tenga que escribir nada.

> `TU_CONTRASEÑA` es un **marcador**. No escribas la contraseña real en este
> archivo ni la subas al repositorio. Si necesitas recordarla, guárdala en un
> gestor de contraseñas.

---

## 0. Datos fijos de esta instalación

| Dato | Valor |
|---|---|
| Nombre del servidor Jellyfin | **Pepflix** |
| Usuario Jellyfin | `Daniel` |
| Contraseña Jellyfin | `TU_CONTRASEÑA` |
| IP LAN del servidor | `192.168.100.46` |
| Jellyfin (TV / app) | `http://192.168.100.46:8096` |
| Portal Pepflix (móvil / PC) | `http://192.168.100.46:8088` |
| Jellyseerr (peticiones) | `http://192.168.100.46:5055` |

La IP `192.168.100.46` es la que tiene ahora este servidor.  
**Resérvala en el router** (DHCP → reserva de IP / IP estática) para que no cambie.  
Si cambia, edita `JELLYFIN_PUBLISHED_URL` en `.env`, recrea Jellyfin y actualiza esta guía.

Ya se han aplicado estos cambios en el repo:

- `JELLYFIN_PublishedServerUrl` ya no apunta a `localhost`, sino a la IP LAN.
- El nombre del servidor Jellyfin se ha cambiado a **Pepflix** para que aparezca así en la app.

---

## 1. Elige el método según tu TV

### Caso A — Android TV / Google TV / Chromecast with Google TV / NVIDIA Shield / Sony / Philips / TCL / Hisense / Xiaomi

Es el caso más fácil y recomendado.

1. En la TV, abre **Google Play Store**.
2. Busca **Jellyfin**.
3. Instala la app oficial de Jellyfin.
4. Abre la app.
5. Normalmente encontrará el servidor **Pepflix** automáticamente. Si no aparece, pulsa **Manual** y escribe:
   `http://192.168.100.46:8096`
6. Inicia sesión:
   - Usuario: `Daniel`
   - Contraseña: `TU_CONTRASEÑA`
7. Cuando pregunte si quieres guardar la contraseña o iniciar sesión automáticamente, **acepta**.
8. Sal a la pantalla de inicio.
9. Coloca la app **Jellyfin** en la primera fila:
   - Selecciona la app.
   - Pulsa el botón de **opciones** (normalmente ≡ o ★).
   - Elige **Mover al principio**, **Añadir a favoritos** o **Fijar**.

Resultado: papá pulsa Inicio → Jellyfin → OK.

---

### Caso B — Amazon Fire TV / Fire Stick

1. En el Fire TV, abre la **Appstore**.
2. Busca **Jellyfin** e instálalo.
3. Abre la app y añade el servidor:
   `http://192.168.100.46:8096`
4. Inicia sesión con `Daniel` / `TU_CONTRASEÑA`.
5. Acepta recordar la sesión.
6. Pon la app al principio:
   - Selecciona Jellyfin.
   - Pulsa el botón de opciones (tres líneas).
   - Elige **Mover al frente** o **Añadir a favoritos**.

Si Jellyfin no aparece en la Appstore de tu región:

1. Instala la app **Downloader** desde la Appstore de Amazon.
2. Desde el navegador de Downloader, baja el APK oficial desde  
   `https://jellyfin.org/downloads/`
3. Instala el APK y sigue los pasos 3 a 6.

---

### Caso C — Samsung Tizen (tu caso)

La TV Samsung es solo el reproductor. La biblioteca sigue estando en el servidor de casa.  
La app oficial de Jellyfin para Tizen está en la tienda de Samsung desde 2026 para TVs **Tizen 6 o superior** (modelos de 2021 en adelante). En modelos anteriores hay que instalarla de forma manual.

#### Paso 1 — Comprueba la versión de Tizen

En la TV: **Ajustes → Asistencia / Soporte → Acerca de esta TV** (o **Actualización de software**).  
También puedes mirar la etiqueta detrás de la TV: el modelo indica el año.

| Año de la TV | Tizen | Método |
|---|---|---|
| 2021 o posterior | 6 o superior | **Tienda Samsung** (lo normal) |
| 2020 o anterior | 5 o inferior | **Instalación manual** (sideload) |

Si no sabes el año, prueba primero la tienda. Si no aparece Jellyfin, usa el método manual.

#### Paso 2A — Instalar desde la tienda Samsung (Tizen 6+)

1. Pulsa **Inicio / Smart Hub**.
2. Abre **Apps**.
3. Selecciona **Buscar** y escribe **Jellyfin**.
4. Pulsa **Instalar**.
5. Abre la app.
6. Cuando pida el servidor, escribe:
   `192.168.100.46:8096`
   (No escribas `http://`, solo la IP y el puerto; si la app te deja poner la URL completa, usa `http://192.168.100.46:8096`.)
7. Inicia sesión:
   - Usuario: `Daniel`
   - Contraseña: `TU_CONTRASEÑA`
8. Acepta guardar la sesión / iniciar sesión automáticamente para que papá no tenga que escribir nada.
9. Sal a Inicio y deja el icono **Jellyfin** en la primera fila:
   - Selecciona el icono.
   - Pulsa el botón de opciones (≡, ★ o ···).
   - Elige **Añadir a favoritos** o **Mover al principio**.

#### Paso 2B — Instalar manualmente si no está en la tienda (Tizen 5 o anterior)

Necesitas un ordenador en la misma red y la IP de la TV (**Ajustes → Red → Estado de red**).

1. En la TV, abre **Apps**.
2. Con el mando, escribe **12345**. Se abre la pantalla de **Modo Desarrollador**.
3. Activa **Developer Mode / Modo desarrollador**.
4. En “Host PC IP”, escribe la IP del ordenador que hará la instalación  
   (si usas el servidor de casa, `192.168.100.46`).
5. Reinicia la TV por completo: mantén pulsado **Encendido** hasta que aparezca el logo de Samsung.
6. Vuelve a Apps y comprueba que sigue activo el Modo Desarrollador.

Ahora elige una de estas dos formas:

**Opción fácil — Apps2Samsung**

1. Instala **Apps2Samsung** en el ordenador (Windows, macOS, Linux o Android).
2. Ábrelo y deja que encuentre la TV en la red. Si no la ve, añádela con la IP de la TV.
3. Selecciona **Jellyfin** entre las apps disponibles y pulsa instalar.
4. Acepta los permisos que salgan en la TV.

**Opción con Docker desde este servidor**

Si prefieres usar el Docker que ya tenemos en casa, con la IP de la TV:

```bash
docker run --rm georift/install-jellyfin-tizen IP_DE_LA_TV
```

Sustituye `IP_DE_LA_TV` por la IP real (por ejemplo `192.168.100.20`).  
El contenedor descarga, firma e instala la app en la TV. Después ya no hace falta.

**Opción oficial / avanzada**

Las instrucciones oficiales de compilación están en `https://github.com/jellyfin/jellyfin-tizen`.  
Requiere Tizen Studio, certificados y Node.js; solo recomendable si las opciones anteriores fallan.

Tras instalar por cualquiera de estas vías, abre **Jellyfin** en la TV y sigue los pasos 6 a 9 del apartado anterior (servidor `192.168.100.46:8096`, usuario `Daniel`, contraseña `TU_CONTRASEÑA`).

#### Nota para LG webOS

En LG webOS la app oficial no suele estar en la tienda. La opción más sencilla es un **Fire TV Stick** o **Chromecast with Google TV** conectado por HDMI y seguir el Caso A o B.

#### Si el vídeo se corta

Algunos Samsung Tizen no reproducen ciertos códecs (HEVC, Dolby Vision, etc.).  
Si una película se corta o no suena, dímelo y ajusto Jellyfin para que convierta el vídeo automáticamente (transcodificación) o bajo la calidad desde el perfil de `Daniel`.

---

### Caso D — Apple TV

1. Abre la **App Store** del Apple TV.
2. Busca **Jellyfin** o **Swiftfin** (cliente de Jellyfin para tvOS).
3. Si está disponible, instálalo y añade el servidor:
   `http://192.168.100.46:8096`
4. Inicia sesión con `Daniel` / `TU_CONTRASEÑA`.
5. Si no hay cliente disponible en tu región, usa un Fire TV Stick o Chromecast con Google TV (Caso A/B).

---

### Caso E — Cualquier TV con HDMI

Si la TV es muy antigua o no tiene smart TV:

1. Conecta un **Fire TV Stick** o **Chromecast with Google TV** al HDMI.
2. Conéctalo al WiFi de casa.
3. Sigue el **Caso A** o **Caso B**.
4. Deja el mando del stick al lado del de la TV.

---

## 2. Ajustes para que sea fácil para papá

Una vez instalada la app:

- Deja **Jellyfin/Pepflix** como primer icono de la pantalla de inicio.
- Si puedes, borra o esconde apps que no use (YouTube, Netflix, etc.). Cuantos menos iconos, mejor.
- Activa el inicio de sesión automático para que no tenga que escribir la contraseña.
- Comprueba que el perfil de `Daniel` no tenga control parental que bloquee películas.
- Pon un cartel pequeño junto a la TV con la guía `MANUAL-PEPFLIX-PAPA.md`.

---

## 3. Prueba antes de dársela

Haz esta prueba tú primero:

1. Apaga la TV y enciéndela.
2. Pulsa Inicio.
3. Abre Jellyfin/Pepflix.
4. Entra en **Películas**.
5. Reproduce una película corta o un capítulo.
6. Pausa y reanuda.
7. Vuelve atrás y cierra la app.
8. Vuelve a abrirla y comprueba que recuerda dónde la dejó.

Luego haz que papá lo intente solo, sin ayudarle.  
Si se atora en algún paso, simplifica la guía o esconde más iconos.

---

## 4. Red y problemas habituales

La TV y el servidor deben estar en la **misma red de casa**.

| Síntoma | Causa probable | Solución |
|---|---|---|
| La app no encuentra el servidor | WiFi de invitados o aislamiento de cliente | Conecta la TV al WiFi normal, no al de invitados |
| Encuentra el servidor pero no entra | Contraseña cambiada o WiFi distinto | Comprueba `Daniel` / `TU_CONTRASEÑA` y la IP |
| “No se puede conectar” | El servidor está apagado | Enciende el PC/servidor y espera 1 minuto |
| Va lento | WiFi débil o lejano | Acerca la TV al router o usa Ethernet |
| La imagen se corta | Habilidad de red o códec | Prueba otra película y reinicia la app |

Comandos útiles en el servidor:

```bash
docker ps --filter name=homelab-jellyfin
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8096/
```

---

## 5. Mantenimiento

- El servidor debe seguir encendido. No lo apagues por la noche si papá quiere ver algo por la mañana.
- Las actualizaciones las haces tú, no papá.
- No cambies la IP sin avisar. Si cambia, actualiza `JELLYFIN_PUBLISHED_URL` y esta guía.
- Backup de la configuración de Jellyfin: `local-storage/appdata/jellyfin/config`.
- Si cambias la contraseña de Jellyfin, actualiza la tarjeta de acceso de la guía de papá.

---

## 6. Resumen técnico

```text
TV  ──(app Jellyfin / Pepflix)──>  http://192.168.100.46:8096
Móvil/PC ──(navegador)──────────>  http://192.168.100.46:8088  (portal Pepflix)
Peticiones ──────────────────────>  http://192.168.100.46:5055  (Jellyseerr)
```

Papá solo ve el icono. El resto (Prowlarr, qBittorrent, Sonarr, Radarr, etc.) trabaja detrás y no le concierne.
