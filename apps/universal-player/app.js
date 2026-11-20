/* ============================================================================
   Homelab Universal Player PWA — Lógica 100% Local-First (Vanilla JS)
   - File API / Directory Picker / Drag & Drop sin subir archivos al servidor
   - Conversor integrado SRT / ASS -> WebVTT con ajuste dinámico de desfase
   - Persistencia de progreso en IndexedDB con fallback automático a localStorage
   - Visualizador de espectro Web Audio API para pistas de solo audio
   ============================================================================ */

(() => {
  'use strict';

  const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'avi', 'ts', 'm2ts', '3gp']);
  const AUDIO_EXTS = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'wma', 'weba']);
  const SUB_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa']);

  // --------------------------------------------------------------------------
  // 1. Almacenamiento de progreso: IndexedDB con fallback a localStorage
  // --------------------------------------------------------------------------
  class ProgressStore {
    constructor() {
      this.dbName = 'homelab-universal-player-db';
      this.storeName = 'playback_progress';
      this.lsKey = 'homelab_universal_player_progress_v1';
      this.db = null;
      this.engine = 'localStorage';
    }

    async init() {
      if (!('indexedDB' in window)) {
        this.engine = 'localStorage';
        return this.engine;
      }
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(this.dbName, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(this.storeName)) {
              const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
              store.createIndex('updatedAt', 'updatedAt', { unique: false });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        this.engine = 'IndexedDB';
      } catch (err) {
        console.warn('IndexedDB no disponible, usando localStorage:', err);
        this.db = null;
        this.engine = 'localStorage';
      }
      return this.engine;
    }

    _readLocalMap() {
      try {
        return JSON.parse(localStorage.getItem(this.lsKey) || '{}');
      } catch {
        return {};
      }
    }

    _writeLocalMap(map) {
      try {
        localStorage.setItem(this.lsKey, JSON.stringify(map));
      } catch (err) {
        console.warn('No se pudo escribir en localStorage:', err);
      }
    }

    async save(record) {
      if (this.db) {
        try {
          await new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          return;
        } catch (err) {
          console.warn('Error guardando en IndexedDB, usando fallback:', err);
        }
      }
      const map = this._readLocalMap();
      map[record.id] = record;
      this._writeLocalMap(map);
    }

    async get(id) {
      if (this.db) {
        try {
          return await new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
          });
        } catch {
          return null;
        }
      }
      const map = this._readLocalMap();
      return map[id] || null;
    }

    async getAll() {
      if (this.db) {
        try {
          const rows = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });
          return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        } catch {
          return [];
        }
      }
      return Object.values(this._readLocalMap()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    async clear() {
      if (this.db) {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction(this.storeName, 'readwrite');
          tx.objectStore(this.storeName).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      localStorage.removeItem(this.lsKey);
    }
  }

  // --------------------------------------------------------------------------
  // 2. Conversor de Subtítulos SRT / ASS / VTT -> WebVTT con offset dinámico
  // --------------------------------------------------------------------------
  function parseTimestampToSeconds(raw) {
    const clean = raw.trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    if (parts.length === 2) {
      return Number(parts[0]) * 60 + Number(parts[1]);
    }
    return 0;
  }

  function formatVttTimestamp(totalSeconds) {
    const safe = Math.max(0, totalSeconds);
    const hrs = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    const ms = Math.round((safe - Math.floor(safe)) * 1000);
    const pad2 = (n) => String(n).padStart(2, '0');
    const pad3 = (n) => String(n).padStart(3, '0');
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}.${pad3(ms)}`;
  }

  function shiftVttTimeRange(line, offsetSeconds) {
    const match = line.match(
      /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3})(.*)/
    );
    if (!match) return line;
    const start = parseTimestampToSeconds(match[1]) + offsetSeconds;
    const end = parseTimestampToSeconds(match[2]) + offsetSeconds;
    if (end <= 0) return null;
    return `${formatVttTimestamp(start)} --> ${formatVttTimestamp(Math.max(start + 0.1, end))}${match[3] || ''}`;
  }

  function convertSrtToVtt(text, offsetSeconds = 0) {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const cues = ['WEBVTT\n'];

    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      if (!lines.length) continue;

      let timeLineIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeLineIdx === -1) continue;

      const shiftedRange = shiftVttTimeRange(lines[timeLineIdx], offsetSeconds);
      if (!shiftedRange) continue;

      const payload = lines.slice(timeLineIdx + 1).join('\n');
      if (payload.trim()) {
        cues.push(`${shiftedRange}\n${payload}\n`);
      }
    }
    return cues.join('\n');
  }

  function convertAssToVtt(text, offsetSeconds = 0) {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const cues = ['WEBVTT\n'];

    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue;
      // Format: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      const parts = line.slice('Dialogue:'.length).trim().split(',');
      if (parts.length < 10) continue;
      const start = parseTimestampToSeconds(parts[1]) + offsetSeconds;
      const end = parseTimestampToSeconds(parts[2]) + offsetSeconds;
      if (end <= 0) continue;
      const rawText = parts.slice(9).join(',');
      const cleanText = rawText
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/gi, '\n')
        .replace(/\\h/g, ' ')
        .trim();
      if (cleanText) {
        cues.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(Math.max(start + 0.1, end))}\n${cleanText}\n`);
      }
    }
    return cues.join('\n');
  }

  function buildVttFromRaw(rawText, ext, offsetSeconds = 0) {
    const lowerExt = (ext || '').toLowerCase();
    if (lowerExt === 'ass' || lowerExt === 'ssa') {
      return convertAssToVtt(rawText, offsetSeconds);
    }
    // Tanto .srt como .vtt pasan por el normalizador para soportar offset dinámico
    return convertSrtToVtt(rawText, offsetSeconds);
  }

  // --------------------------------------------------------------------------
  // 3. Utilidades
  // --------------------------------------------------------------------------
  function getExtension(filename) {
    const idx = filename.lastIndexOf('.');
    return idx === -1 ? '' : filename.slice(idx + 1).toLowerCase();
  }

  function getBasename(filename) {
    const idx = filename.lastIndexOf('.');
    return idx === -1 ? filename.toLowerCase() : filename.slice(0, idx).toLowerCase();
  }

  function classifyFile(file) {
    const ext = getExtension(file.name);
    if (SUB_EXTS.has(ext)) return 'subtitle';
    if (file.type.startsWith('video/') || VIDEO_EXTS.has(ext)) return 'video';
    if (file.type.startsWith('audio/') || AUDIO_EXTS.has(ext)) return 'audio';
    return 'unknown';
  }

  function fileFingerprint(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  }

  // --------------------------------------------------------------------------
  // 4. Estado global y referencias DOM
  // --------------------------------------------------------------------------
  const store = new ProgressStore();
  const state = {
    queue: [],          // [{ id, file, type, url, subtitleFile, subtitleName, progressPct }]
    currentIndex: -1,
    shuffle: false,
    repeat: 'off',      // 'off' | 'all' | 'one'
    subEnabled: true,
    subOffset: 0,
    subRawText: null,
    subExt: null,
    subTrackUrl: null,
    isSeeking: false,
    lastSaveTs: 0,
    historyCache: new Map(),
    pendingSubtitles: new Map() // basename -> File
  };

  const els = {
    media: document.getElementById('mediaElement'),
    stage: document.getElementById('playerStage'),
    emptyState: document.getElementById('emptyState'),
    dragOverlay: document.getElementById('dragOverlay'),
    audioOverlay: document.getElementById('audioVisualOverlay'),
    audioCanvas: document.getElementById('audioCanvas'),
    audioTrackTitle: document.getElementById('audioTrackTitle'),
    audioTrackInfo: document.getElementById('audioTrackInfo'),
    resumeToast: document.getElementById('resumeToast'),
    resumeToastText: document.getElementById('resumeToastText'),
    btnRestartFromZero: document.getElementById('btnRestartFromZero'),
    btnCloseToast: document.getElementById('btnCloseToast'),
    statusPill: document.getElementById('statusPill'),

    fileInput: document.getElementById('fileInput'),
    folderInput: document.getElementById('folderInput'),
    subtitleInput: document.getElementById('subtitleInput'),

    btnAddFiles: document.getElementById('btnAddFiles'),
    btnAddFolder: document.getElementById('btnAddFolder'),
    btnLoadSubtitle: document.getElementById('btnLoadSubtitle'),
    btnEmptyPickFiles: document.getElementById('btnEmptyPickFiles'),
    btnEmptyPickFolder: document.getElementById('btnEmptyPickFolder'),
    btnShortcuts: document.getElementById('btnShortcuts'),
    shortcutsModal: document.getElementById('shortcutsModal'),
    btnCloseShortcuts: document.getElementById('btnCloseShortcuts'),

    mediaTypeBadge: document.getElementById('mediaTypeBadge'),
    currentTitle: document.getElementById('currentTitle'),
    subtitleLabel: document.getElementById('subtitleLabel'),
    btnToggleSub: document.getElementById('btnToggleSub'),
    btnSubDelayMinus: document.getElementById('btnSubDelayMinus'),
    btnSubDelayPlus: document.getElementById('btnSubDelayPlus'),
    subOffsetDisplay: document.getElementById('subOffsetDisplay'),
    subSizeSelect: document.getElementById('subSizeSelect'),

    timeCurrent: document.getElementById('timeCurrent'),
    timeTotal: document.getElementById('timeTotal'),
    seekBar: document.getElementById('seekBar'),
    btnPrev: document.getElementById('btnPrev'),
    btnRewind: document.getElementById('btnRewind'),
    btnPlayPause: document.getElementById('btnPlayPause'),
    btnForward: document.getElementById('btnForward'),
    btnNext: document.getElementById('btnNext'),
    btnMute: document.getElementById('btnMute'),
    volumeBar: document.getElementById('volumeBar'),
    speedSelect: document.getElementById('speedSelect'),
    btnPiP: document.getElementById('btnPiP'),
    btnFullscreen: document.getElementById('btnFullscreen'),

    tabQueue: document.getElementById('tabQueue'),
    tabHistory: document.getElementById('tabHistory'),
    panelQueue: document.getElementById('panelQueue'),
    panelHistory: document.getElementById('panelHistory'),
    queueCount: document.getElementById('queueCount'),
    historyCount: document.getElementById('historyCount'),
    queueSearch: document.getElementById('queueSearch'),
    btnShuffle: document.getElementById('btnShuffle'),
    btnRepeat: document.getElementById('btnRepeat'),
    btnClearQueue: document.getElementById('btnClearQueue'),
    playlistList: document.getElementById('playlistList'),
    historyList: document.getElementById('historyList'),
    btnClearHistory: document.getElementById('btnClearHistory'),
    storageEngineLabel: document.getElementById('storageEngineLabel')
  };

  let statusTimer = null;
  function showStatus(msg) {
    els.statusPill.textContent = msg;
    els.statusPill.classList.remove('hidden');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => els.statusPill.classList.add('hidden'), 2000);
  }

  // --------------------------------------------------------------------------
  // 5. Visualizador Web Audio API para pistas de audio
  // --------------------------------------------------------------------------
  let audioCtx = null;
  let analyser = null;
  let audioData = null;
  let animFrameId = null;

  function ensureAudioVisualizer() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      const source = audioCtx.createMediaElementSource(els.media);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      audioData = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      console.warn('No se pudo iniciar el visualizador de audio:', err);
    }
  }

  function renderAudioBars() {
    if (!analyser || els.audioOverlay.classList.contains('hidden')) {
      animFrameId = null;
      return;
    }
    const ctx = els.audioCanvas.getContext('2d');
    const w = els.audioCanvas.width;
    const h = els.audioCanvas.height;
    ctx.clearRect(0, 0, w, h);

    analyser.getByteFrequencyData(audioData);
    const barCount = Math.min(48, audioData.length);
    const barWidth = (w / barCount) - 4;

    for (let i = 0; i < barCount; i++) {
      const val = audioData[i] / 255;
      const barHeight = Math.max(6, val * (h - 14));
      const x = i * (barWidth + 4) + 2;
      const y = h - barHeight;
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, '#38bdf8');
      grad.addColorStop(1, '#6366f1');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 4);
      ctx.fill();
    }
    animFrameId = requestAnimationFrame(renderAudioBars);
  }

  // --------------------------------------------------------------------------
  // 6. Gestión de Subtítulos
  // --------------------------------------------------------------------------
  function clearSubtitles() {
    Array.from(els.media.querySelectorAll('track')).forEach((t) => t.remove());
    if (state.subTrackUrl) {
      URL.revokeObjectURL(state.subTrackUrl);
      state.subTrackUrl = null;
    }
    state.subRawText = null;
    state.subExt = null;
    state.subOffset = 0;
    els.subtitleLabel.textContent = 'Sin subtítulos';
    els.subOffsetDisplay.textContent = '0.0s';
    els.btnToggleSub.disabled = true;
    els.btnToggleSub.classList.remove('active');
    els.btnSubDelayMinus.disabled = true;
    els.btnSubDelayPlus.disabled = true;
  }

  function applySubtitleTrack(label) {
    if (!state.subRawText) return;
    Array.from(els.media.querySelectorAll('track')).forEach((t) => t.remove());
    if (state.subTrackUrl) {
      URL.revokeObjectURL(state.subTrackUrl);
    }

    const vttContent = buildVttFromRaw(state.subRawText, state.subExt, state.subOffset);
    const blob = new Blob([vttContent], { type: 'text/vtt;charset=utf-8' });
    state.subTrackUrl = URL.createObjectURL(blob);

    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label || 'Subtítulos locales';
    track.srclang = 'es';
    track.src = state.subTrackUrl;
    track.default = true;
    els.media.appendChild(track);

    // Activar modo de pista inmediatamente
    requestAnimationFrame(() => {
      if (els.media.textTracks.length > 0) {
        els.media.textTracks[0].mode = state.subEnabled ? 'showing' : 'hidden';
      }
    });

    els.subtitleLabel.textContent = label || 'Subtítulos';
    els.subOffsetDisplay.textContent = `${state.subOffset >= 0 ? '+' : ''}${state.subOffset.toFixed(1)}s`;
    els.btnToggleSub.disabled = false;
    els.btnToggleSub.classList.toggle('active', state.subEnabled);
    els.btnSubDelayMinus.disabled = false;
    els.btnSubDelayPlus.disabled = false;
  }

  async function loadSubtitleFile(file) {
    try {
      const text = await file.text();
      state.subRawText = text;
      state.subExt = getExtension(file.name);
      state.subOffset = 0;
      state.subEnabled = true;

      const currentItem = state.queue[state.currentIndex];
      if (currentItem) {
        currentItem.subtitleFile = file;
        currentItem.subtitleName = file.name;
      }

      applySubtitleTrack(file.name);
      renderPlaylist();
      showStatus(`CC cargado: ${file.name}`);
    } catch (err) {
      console.error('Error leyendo subtítulo:', err);
      showStatus('Error al cargar subtítulos');
    }
  }

  function toggleSubtitles() {
    if (!state.subRawText) return;
    state.subEnabled = !state.subEnabled;
    if (els.media.textTracks.length > 0) {
      els.media.textTracks[0].mode = state.subEnabled ? 'showing' : 'hidden';
    }
    els.btnToggleSub.classList.toggle('active', state.subEnabled);
    showStatus(state.subEnabled ? 'Subtítulos activados' : 'Subtítulos ocultos');
  }

  function shiftSubtitles(delta) {
    if (!state.subRawText) return;
    state.subOffset = Math.round((state.subOffset + delta) * 10) / 10;
    const currentItem = state.queue[state.currentIndex];
    applySubtitleTrack(currentItem?.subtitleName || 'Subtítulos');
    showStatus(`Desfase CC: ${state.subOffset >= 0 ? '+' : ''}${state.subOffset.toFixed(1)}s`);
  }

  // --------------------------------------------------------------------------
  // 7. Gestión de Cola de Reproducción y Carga de Archivos Locales
  // --------------------------------------------------------------------------
  async function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const mediaFiles = [];
    const subFiles = [];

    for (const file of files) {
      const kind = classifyFile(file);
      if (kind === 'subtitle') subFiles.push(file);
      else if (kind === 'video' || kind === 'audio') mediaFiles.push({ file, kind });
    }

    // Registrar subtítulos por nombre base para auto-emparejamiento
    for (const sf of subFiles) {
      state.pendingSubtitles.set(getBasename(sf.name), sf);
    }

    // Si solo se soltó un subtítulo y ya hay algo reproduciéndose, aplicarlo directamente
    if (!mediaFiles.length && subFiles.length > 0 && state.currentIndex >= 0) {
      await loadSubtitleFile(subFiles[0]);
      return;
    }

    // Ordenar archivos de forma natural (útil para episodios / álbumes)
    mediaFiles.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));

    const firstAddedIndex = state.queue.length;
    for (const { file, kind } of mediaFiles) {
      const id = fileFingerprint(file);
      // Evitar duplicados exactos en la cola actual
      if (state.queue.some((q) => q.id === id)) continue;

      const base = getBasename(file.name);
      const matchedSub = state.pendingSubtitles.get(base) || null;
      const saved = state.historyCache.get(id) || (await store.get(id));
      const progressPct = saved && saved.duration > 0 ? Math.min(100, Math.round((saved.currentTime / saved.duration) * 100)) : 0;

      state.queue.push({
        id,
        file,
        type: kind,
        url: URL.createObjectURL(file),
        subtitleFile: matchedSub,
        subtitleName: matchedSub ? matchedSub.name : null,
        progressPct
      });
    }

    // Emparejar subtítulos recién llegados con elementos ya existentes en cola
    if (subFiles.length > 0) {
      for (const item of state.queue) {
        if (!item.subtitleFile) {
          const matched = state.pendingSubtitles.get(getBasename(item.file.name));
          if (matched) {
            item.subtitleFile = matched;
            item.subtitleName = matched.name;
          }
        }
      }
    }

    renderPlaylist();

    if (state.currentIndex === -1 && state.queue.length > 0) {
      await playIndex(firstAddedIndex < state.queue.length ? firstAddedIndex : 0);
    } else if (mediaFiles.length > 0) {
      showStatus(`Añadidos ${mediaFiles.length} archivo(s) a la cola`);
    }
  }

  async function playIndex(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.currentIndex = index;
    const item = state.queue[index];

    clearSubtitles();
    els.emptyState.classList.add('hidden');
    els.resumeToast.classList.add('hidden');

    els.media.src = item.url;
    els.media.playbackRate = Number(els.speedSelect.value) || 1;
    els.currentTitle.textContent = item.file.name;
    els.mediaTypeBadge.textContent = item.type === 'audio' ? 'AUDIO' : 'VÍDEO';
    els.mediaTypeBadge.className = `badge ${item.type === 'audio' ? 'badge-audio' : 'badge-video'}`;

    if (item.type === 'audio') {
      els.audioOverlay.classList.remove('hidden');
      els.audioTrackTitle.textContent = item.file.name.replace(/\.[^.]+$/, '');
      els.audioTrackInfo.textContent = `${getExtension(item.file.name).toUpperCase()} · ${formatBytes(item.file.size)}`;
    } else {
      els.audioOverlay.classList.add('hidden');
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    }

    // Cargar subtítulo emparejado automáticamente si existe
    if (item.subtitleFile) {
      await loadSubtitleFile(item.subtitleFile);
    }

    // Recuperar posición guardada en IndexedDB / localStorage
    const saved = await store.get(item.id);
    const onMetadata = () => {
      els.timeTotal.textContent = formatDuration(els.media.duration);
      if (saved && saved.currentTime > 5 && els.media.duration && saved.currentTime < els.media.duration - 8) {
        els.media.currentTime = saved.currentTime;
        els.resumeToastText.textContent = `Reanudando desde ${formatDuration(saved.currentTime)}`;
        els.resumeToast.classList.remove('hidden');
      }
      els.media.play().then(() => {
        if (item.type === 'audio') {
          ensureAudioVisualizer();
          if (!animFrameId) renderAudioBars();
        }
      }).catch(() => {});
    };

    els.media.addEventListener('loadedmetadata', onMetadata, { once: true });
    els.media.load();

    // MediaSession API para controles multimedia del sistema operativo
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.file.name,
        artist: 'Homelab Universal Player (Local)'
      });
    }

    renderPlaylist();
  }

  function playNext(autoAdvance = false) {
    if (!state.queue.length) return;
    if (autoAdvance && state.repeat === 'one') {
      els.media.currentTime = 0;
      els.media.play().catch(() => {});
      return;
    }
    if (state.shuffle && state.queue.length > 1) {
      let nextIdx = state.currentIndex;
      while (nextIdx === state.currentIndex) {
        nextIdx = Math.floor(Math.random() * state.queue.length);
      }
      playIndex(nextIdx);
      return;
    }
    if (state.currentIndex + 1 < state.queue.length) {
      playIndex(state.currentIndex + 1);
    } else if (state.repeat === 'all') {
      playIndex(0);
    }
  }

  function playPrev() {
    if (!state.queue.length) return;
    if (els.media.currentTime > 4) {
      els.media.currentTime = 0;
      return;
    }
    if (state.currentIndex > 0) {
      playIndex(state.currentIndex - 1);
    } else if (state.repeat === 'all') {
      playIndex(state.queue.length - 1);
    }
  }

  function removeQueueItem(idx) {
    const [removed] = state.queue.splice(idx, 1);
    if (removed) URL.revokeObjectURL(removed.url);

    if (!state.queue.length) {
      resetPlayer();
    } else if (idx === state.currentIndex) {
      playIndex(Math.min(idx, state.queue.length - 1));
    } else if (idx < state.currentIndex) {
      state.currentIndex -= 1;
    }
    renderPlaylist();
  }

  function moveQueueItem(idx, direction) {
    const target = idx + direction;
    if (target < 0 || target >= state.queue.length) return;
    const temp = state.queue[idx];
    state.queue[idx] = state.queue[target];
    state.queue[target] = temp;

    if (state.currentIndex === idx) state.currentIndex = target;
    else if (state.currentIndex === target) state.currentIndex = idx;
    renderPlaylist();
  }

  function resetPlayer() {
    els.media.pause();
    els.media.removeAttribute('src');
    els.media.load();
    clearSubtitles();
    state.currentIndex = -1;
    els.emptyState.classList.remove('hidden');
    els.audioOverlay.classList.add('hidden');
    els.resumeToast.classList.add('hidden');
    els.currentTitle.textContent = 'Ningún archivo seleccionado';
    els.mediaTypeBadge.textContent = 'LISTO';
    els.mediaTypeBadge.className = 'badge badge-idle';
    els.timeCurrent.textContent = '00:00';
    els.timeTotal.textContent = '00:00';
    els.seekBar.value = 0;
    els.btnPlayPause.textContent = '▶';
  }

  // --------------------------------------------------------------------------
  // 8. Persistencia automática de progreso
  // --------------------------------------------------------------------------
  async function persistCurrentProgress(force = false) {
    const item = state.queue[state.currentIndex];
    if (!item || !Number.isFinite(els.media.duration) || els.media.duration <= 0) return;

    const now = Date.now();
    if (!force && now - state.lastSaveTs < 2500) return;
    state.lastSaveTs = now;

    const currentTime = els.media.currentTime;
    const duration = els.media.duration;
    const pct = Math.min(100, Math.round((currentTime / duration) * 100));
    item.progressPct = pct;

    const record = {
      id: item.id,
      name: item.file.name,
      type: item.type,
      size: item.file.size,
      currentTime,
      duration,
      progressPct: pct,
      updatedAt: now
    };
    state.historyCache.set(item.id, record);
    await store.save(record);
    renderHistory();
  }

  // --------------------------------------------------------------------------
  // 9. Renderizado UI (Cola e Historial)
  // --------------------------------------------------------------------------
  function renderPlaylist() {
    els.queueCount.textContent = String(state.queue.length);
    const filter = (els.queueSearch.value || '').trim().toLowerCase();
    els.playlistList.innerHTML = '';

    const entries = state.queue
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => !filter || item.file.name.toLowerCase().includes(filter));

    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'playlist-empty';
      li.textContent = state.queue.length ? 'Sin coincidencias en la búsqueda.' : 'No hay archivos en la cola todavía.';
      els.playlistList.appendChild(li);
      return;
    }

    for (const { item, idx } of entries) {
      const li = document.createElement('li');
      li.className = `playlist-item ${idx === state.currentIndex ? 'active' : ''}`;

      const top = document.createElement('div');
      top.className = 'item-top';

      const name = document.createElement('span');
      name.className = 'item-name';
      name.title = item.file.name;
      name.textContent = `${item.type === 'audio' ? '🎵' : '🎬'} ${item.file.name}`;
      top.appendChild(name);

      if (item.subtitleName) {
        const cc = document.createElement('span');
        cc.className = 'cc-pill';
        cc.textContent = 'CC';
        cc.title = item.subtitleName;
        top.appendChild(cc);
      }

      const meta = document.createElement('div');
      meta.className = 'item-meta';

      const info = document.createElement('span');
      info.textContent = `${formatBytes(item.file.size)} · ${item.progressPct || 0}%`;
      meta.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const btnUp = document.createElement('button');
      btnUp.className = 'item-btn';
      btnUp.type = 'button';
      btnUp.textContent = '↑';
      btnUp.title = 'Subir';
      btnUp.addEventListener('click', (e) => {
        e.stopPropagation();
        moveQueueItem(idx, -1);
      });

      const btnDown = document.createElement('button');
      btnDown.className = 'item-btn';
      btnDown.type = 'button';
      btnDown.textContent = '↓';
      btnDown.title = 'Bajar';
      btnDown.addEventListener('click', (e) => {
        e.stopPropagation();
        moveQueueItem(idx, 1);
      });

      const btnDel = document.createElement('button');
      btnDel.className = 'item-btn';
      btnDel.type = 'button';
      btnDel.textContent = '✕';
      btnDel.title = 'Quitar de la cola';
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        removeQueueItem(idx);
      });

      actions.append(btnUp, btnDown, btnDel);
      meta.appendChild(actions);

      const bar = document.createElement('div');
      bar.className = 'progress-mini';
      const fill = document.createElement('div');
      fill.className = 'progress-mini-fill';
      fill.style.width = `${item.progressPct || 0}%`;
      bar.appendChild(fill);

      li.append(top, meta, bar);
      li.addEventListener('click', () => playIndex(idx));
      els.playlistList.appendChild(li);
    }
  }

  async function renderHistory() {
    const records = await store.getAll();
    els.historyCount.textContent = String(records.length);
    state.historyCache.clear();
    records.forEach((r) => state.historyCache.set(r.id, r));

    els.historyList.innerHTML = '';
    if (!records.length) {
      const li = document.createElement('li');
      li.className = 'playlist-empty';
      li.textContent = 'Sin reproducciones guardadas todavía.';
      els.historyList.appendChild(li);
      return;
    }

    for (const rec of records.slice(0, 40)) {
      const li = document.createElement('li');
      li.className = 'playlist-item';

      const top = document.createElement('div');
      top.className = 'item-top';
      const name = document.createElement('span');
      name.className = 'item-name';
      name.title = rec.name;
      name.textContent = `${rec.type === 'audio' ? '🎵' : '🎬'} ${rec.name}`;
      top.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const pos = document.createElement('span');
      pos.textContent = `${formatDuration(rec.currentTime)} / ${formatDuration(rec.duration)}`;
      const pct = document.createElement('span');
      pct.textContent = `${rec.progressPct || 0}%`;
      meta.append(pos, pct);

      const bar = document.createElement('div');
      bar.className = 'progress-mini';
      const fill = document.createElement('div');
      fill.className = 'progress-mini-fill';
      fill.style.width = `${rec.progressPct || 0}%`;
      bar.appendChild(fill);

      li.append(top, meta, bar);
      li.addEventListener('click', () => {
        const idx = state.queue.findIndex((q) => q.id === rec.id);
        if (idx !== -1) {
          playIndex(idx);
        } else {
          showStatus('Vuelve a seleccionar este archivo para reanudarlo');
          els.fileInput.click();
        }
      });
      els.historyList.appendChild(li);
    }
  }

  // --------------------------------------------------------------------------
  // 10. Eventos de controles, teclado y Drag & Drop
  // --------------------------------------------------------------------------
  function togglePlay() {
    if (!els.media.src) {
      if (state.queue.length) playIndex(0);
      else els.fileInput.click();
      return;
    }
    if (els.media.paused) {
      els.media.play().catch(() => {});
    } else {
      els.media.pause();
    }
  }

  function updateVolumeIcon() {
    const vol = els.media.muted ? 0 : els.media.volume;
    els.btnMute.textContent = vol === 0 ? '🔇' : vol < 0.5 ? '🔉' : '🔊';
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      els.stage.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  async function togglePiP() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (els.media.readyState >= 1 && document.pictureInPictureEnabled) {
        await els.media.requestPictureInPicture();
      }
    } catch {
      showStatus('PiP no disponible para este archivo');
    }
  }

  function wireEvents() {
    // Selectores de archivos
    els.btnAddFiles.addEventListener('click', () => els.fileInput.click());
    els.btnEmptyPickFiles.addEventListener('click', () => els.fileInput.click());
    els.btnAddFolder.addEventListener('click', () => els.folderInput.click());
    els.btnEmptyPickFolder.addEventListener('click', () => els.folderInput.click());
    els.btnLoadSubtitle.addEventListener('click', () => els.subtitleInput.click());

    els.fileInput.addEventListener('change', (e) => {
      ingestFiles(e.target.files);
      e.target.value = '';
    });
    els.folderInput.addEventListener('change', (e) => {
      ingestFiles(e.target.files);
      e.target.value = '';
    });
    els.subtitleInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        loadSubtitleFile(e.target.files[0]);
      }
      e.target.value = '';
    });

    // Drag & Drop en toda la ventana
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter += 1;
      els.dragOverlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) els.dragOverlay.classList.add('hidden');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      els.dragOverlay.classList.add('hidden');
      if (e.dataTransfer?.files?.length) {
        ingestFiles(e.dataTransfer.files);
      }
    });

    // Eventos del elemento HTML5 <video>
    els.media.addEventListener('play', () => {
      els.btnPlayPause.textContent = '⏸';
      const item = state.queue[state.currentIndex];
      if (item?.type === 'audio') {
        ensureAudioVisualizer();
        if (!animFrameId) renderAudioBars();
      }
    });

    els.media.addEventListener('pause', () => {
      els.btnPlayPause.textContent = '▶';
      persistCurrentProgress(true);
    });

    els.media.addEventListener('timeupdate', () => {
      if (!state.isSeeking && els.media.duration) {
        els.seekBar.value = String(Math.round((els.media.currentTime / els.media.duration) * 1000));
        els.timeCurrent.textContent = formatDuration(els.media.currentTime);
      }
      persistCurrentProgress(false);
    });

    els.media.addEventListener('ended', () => {
      persistCurrentProgress(true);
      playNext(true);
    });

    els.media.addEventListener('click', togglePlay);
    els.media.addEventListener('dblclick', toggleFullscreen);

    // Controles de transporte
    els.btnPlayPause.addEventListener('click', togglePlay);
    els.btnPrev.addEventListener('click', playPrev);
    els.btnNext.addEventListener('click', () => playNext(false));
    els.btnRewind.addEventListener('click', () => {
      els.media.currentTime = Math.max(0, els.media.currentTime - 10);
      showStatus('-10s');
    });
    els.btnForward.addEventListener('click', () => {
      els.media.currentTime = Math.min(els.media.duration || 0, els.media.currentTime + 10);
      showStatus('+10s');
    });

    els.seekBar.addEventListener('input', () => {
      state.isSeeking = true;
      if (els.media.duration) {
        const target = (Number(els.seekBar.value) / 1000) * els.media.duration;
        els.timeCurrent.textContent = formatDuration(target);
      }
    });
    els.seekBar.addEventListener('change', () => {
      if (els.media.duration) {
        els.media.currentTime = (Number(els.seekBar.value) / 1000) * els.media.duration;
      }
      state.isSeeking = false;
      persistCurrentProgress(true);
    });

    // Volumen y velocidad (guardados en localStorage)
    const savedVol = Number(localStorage.getItem('homelab_player_volume'));
    if (Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 1) {
      els.media.volume = savedVol;
      els.volumeBar.value = String(savedVol);
    }
    updateVolumeIcon();

    els.volumeBar.addEventListener('input', () => {
      const vol = Number(els.volumeBar.value);
      els.media.volume = vol;
      els.media.muted = vol === 0;
      localStorage.setItem('homelab_player_volume', String(vol));
      updateVolumeIcon();
    });

    els.btnMute.addEventListener('click', () => {
      els.media.muted = !els.media.muted;
      updateVolumeIcon();
    });

    els.speedSelect.addEventListener('change', () => {
      els.media.playbackRate = Number(els.speedSelect.value);
      showStatus(`Velocidad ${els.media.playbackRate}x`);
    });

    els.btnPiP.addEventListener('click', togglePiP);
    els.btnFullscreen.addEventListener('click', toggleFullscreen);

    // Subtítulos
    els.btnToggleSub.addEventListener('click', toggleSubtitles);
    els.btnSubDelayMinus.addEventListener('click', () => shiftSubtitles(-0.5));
    els.btnSubDelayPlus.addEventListener('click', () => shiftSubtitles(0.5));
    els.subSizeSelect.addEventListener('change', () => {
      els.stage.classList.remove('sub-sm', 'sub-md', 'sub-lg');
      els.stage.classList.add(els.subSizeSelect.value);
    });
    els.stage.classList.add('sub-md');

    // Toast de reanudación
    els.btnRestartFromZero.addEventListener('click', () => {
      els.media.currentTime = 0;
      els.resumeToast.classList.add('hidden');
      persistCurrentProgress(true);
    });
    els.btnCloseToast.addEventListener('click', () => els.resumeToast.classList.add('hidden'));

    // Pestañas y gestión de cola
    els.tabQueue.addEventListener('click', () => {
      els.tabQueue.classList.add('active');
      els.tabHistory.classList.remove('active');
      els.panelQueue.classList.remove('hidden');
      els.panelHistory.classList.add('hidden');
    });
    els.tabHistory.addEventListener('click', () => {
      els.tabHistory.classList.add('active');
      els.tabQueue.classList.remove('active');
      els.panelHistory.classList.remove('hidden');
      els.panelQueue.classList.add('hidden');
      renderHistory();
    });

    els.queueSearch.addEventListener('input', renderPlaylist);

    els.btnShuffle.addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      els.btnShuffle.classList.toggle('active', state.shuffle);
      showStatus(state.shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado');
    });

    els.btnRepeat.addEventListener('click', () => {
      const cycle = { off: 'all', all: 'one', one: 'off' };
      const labels = { off: '🔁 Off', all: '🔁 Todo', one: '🔂 1' };
      state.repeat = cycle[state.repeat];
      els.btnRepeat.textContent = labels[state.repeat];
      els.btnRepeat.classList.toggle('active', state.repeat !== 'off');
    });

    els.btnClearQueue.addEventListener('click', () => {
      state.queue.forEach((item) => URL.revokeObjectURL(item.url));
      state.queue = [];
      resetPlayer();
      renderPlaylist();
    });

    els.btnClearHistory.addEventListener('click', async () => {
      await store.clear();
      state.queue.forEach((q) => { q.progressPct = 0; });
      renderPlaylist();
      renderHistory();
      showStatus('Historial borrado');
    });

    // Modal atajos
    els.btnShortcuts.addEventListener('click', () => els.shortcutsModal.classList.toggle('hidden'));
    els.btnCloseShortcuts.addEventListener('click', () => els.shortcutsModal.classList.add('hidden'));
    els.shortcutsModal.addEventListener('click', (e) => {
      if (e.target === els.shortcutsModal) els.shortcutsModal.classList.add('hidden');
    });

    // Atajos de teclado globales
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          els.media.currentTime = Math.max(0, els.media.currentTime - 10);
          showStatus('-10s');
          break;
        case 'arrowright':
          e.preventDefault();
          els.media.currentTime = Math.min(els.media.duration || 0, els.media.currentTime + 10);
          showStatus('+10s');
          break;
        case 'arrowup':
          e.preventDefault();
          els.media.volume = Math.min(1, Math.round((els.media.volume + 0.05) * 100) / 100);
          els.volumeBar.value = String(els.media.volume);
          updateVolumeIcon();
          showStatus(`Volumen ${Math.round(els.media.volume * 100)}%`);
          break;
        case 'arrowdown':
          e.preventDefault();
          els.media.volume = Math.max(0, Math.round((els.media.volume - 0.05) * 100) / 100);
          els.volumeBar.value = String(els.media.volume);
          updateVolumeIcon();
          showStatus(`Volumen ${Math.round(els.media.volume * 100)}%`);
          break;
        case 'm':
          els.media.muted = !els.media.muted;
          updateVolumeIcon();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'c':
          toggleSubtitles();
          break;
        case 'n':
          playNext(false);
          break;
        case 'p':
          playPrev();
          break;
        case '?':
          els.shortcutsModal.classList.toggle('hidden');
          break;
        case 'escape':
          els.shortcutsModal.classList.add('hidden');
          break;
      }
    });

    // MediaSession callbacks
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
    }

    window.addEventListener('beforeunload', () => persistCurrentProgress(true));
  }

  // --------------------------------------------------------------------------
  // 11. Arranque
  // --------------------------------------------------------------------------
  async function bootstrap() {
    const engine = await store.init();
    els.storageEngineLabel.textContent = `Persistencia: ${engine}`;
    wireEvents();
    await renderHistory();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  bootstrap();
})();
