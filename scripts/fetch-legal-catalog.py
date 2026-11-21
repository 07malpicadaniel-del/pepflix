#!/usr/bin/env python3
"""Descarga películas y series de dominio público desde Internet Archive.

Fuentes:
  - Películas: collection:(feature_films) con licencia publicdomain
  - Series:    collection:(classic_tv) con licencia publicdomain

Uso:
    ./scripts/fetch-legal-catalog.py --dry-run --limit 5
    ./scripts/fetch-legal-catalog.py --apply --type all --limit 10 --max-size-mb 500

Por defecto NO descarga: solo muestra lo que haría. Usa --apply para descargar.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "local-storage/media"
USER_AGENT = "Pepflix-Legal-Catalog/1.0 (+homelab)"
IA_SEARCH = "https://archive.org/advancedsearch.php"
IA_METADATA = "https://archive.org/metadata/{identifier}"
IA_DOWNLOAD = "https://archive.org/download/{identifier}/{file}"

MOVIE_QUERY = 'collection:(feature_films) AND licenseurl:*publicdomain*'
SERIES_QUERY = 'collection:(classic_tv) AND licenseurl:*publicdomain*'
VIDEO_EXTENSIONS = {".mp4", ".m4v", ".mkv", ".ogv", ".webm", ".avi", ".mov"}
BLOCKED_TITLE_WORDS = {"sex", "nude", "nudist", "adult", "xxx", "porn", "erotic", "prostitut", "brothel", "reefer"}
EPISODE_PATTERNS = [
    re.compile(
        r"^(?P<series>.*?)[\s._\-–—:,;]*[sS](?P<season>\d{1,2})[\s._\-–—]*[eE](?P<episode>\d{1,3})\b"
        r"[\s._\-–—:,;]* (?P<episode_title>.*)$"
    ),
    re.compile(
        r"^(?P<series>.*?)[\s._\-–—:,;]*\b(?P<season>\d{1,2})x(?P<episode>\d{1,3})\b"
        r"[\s._\-–—:,;]* (?P<episode_title>.*)$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?P<series>.*?)[\s._\-–—:,;]*season\s*(?P<season>\d{1,2})[\s._\-–—:,;]*"
        r"episode\s*(?P<episode>\d{1,3})\b[\s._\-–—:,;]* (?P<episode_title>.*)$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?P<series>.*?)[\s._\-–—:,;]*\b(?:ep|episode)\s*(?P<episode>\d{1,3})\b"
        r"[\s._\-–—:,;]* (?P<episode_title>.*)$",
        re.IGNORECASE,
    ),
]


def fetch_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def ia_search(query: str, rows: int):
    params = {
        "q": query,
        "fl[]": ["identifier", "title", "year", "licenseurl"],
        "rows": max(1, min(rows, 100)),
        "page": 1,
        "output": "json",
        "sort[]": "downloads desc",
    }
    url = IA_SEARCH + "?" + urllib.parse.urlencode(params, doseq=True)
    data = fetch_json(url)
    return data.get("response", {}).get("docs", [])


def first(value):
    if isinstance(value, list):
        return value[0] if value else ""
    return value or ""


def safe_name(value: str, limit: int = 170) -> str:
    value = str(value or "").strip()
    value = re.sub(r'[\\/:*?"<>|]+', " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:limit] or "Sin titulo"


def choose_video(files, max_bytes: int, prefer_small: bool = False):
    best = None
    candidates = []
    for item in files:
        name = item.get("name") or ""
        size = int(item.get("size") or 0)
        fmt = (item.get("format") or "").lower()
        suffix = Path(name).suffix.lower()
        if not name or not size or size > max_bytes or suffix not in VIDEO_EXTENSIONS:
            continue
        score = 0
        if "h.264" in fmt or "512kb mpeg4" in fmt or suffix == ".mp4":
            score += 100
        elif "mpeg4" in fmt:
            score += 90
        elif "matroska" in fmt or suffix == ".mkv":
            score += 80
        elif "ogg video" in fmt or suffix == ".ogv":
            score += 60
        elif "webm" in fmt or suffix == ".webm":
            score += 50
        score += min(size / (1024 * 1024), 1500) / 1500
        candidate = (score, size, name)
        candidates.append(candidate)
        if best is None or candidate > best:
            best = candidate
    if best is None:
        return None
    if not prefer_small:
        return best[2]
    minimum = 20 * 1024 * 1024
    small = [c for c in candidates if c[1] >= minimum]
    if not small:
        small = candidates
    return min(small, key=lambda c: (c[1], -c[0]))[2]


def title_year(title: str, year) -> str:
    title = safe_name(title)
    year = str(year or "").strip()
    if year and f"({year})" not in title:
        return safe_name(f"{title} ({year})")
    return title


def parse_episode(title: str):
    clean = title.strip()
    for pattern in EPISODE_PATTERNS:
        match = pattern.match(clean)
        if not match:
            continue
        series = match.group("series").strip(" ._-–—:,;\"'")
        if not series:
            continue
        season = int(match.groupdict().get("season") or 1)
        episode = int(match.group("episode"))
        episode_title = match.group("episode_title").strip(" ._-–—:,;\"'")
        return series, season, episode, episode_title
    return None


def existing_video(folder: Path):
    if not folder.is_dir():
        return None
    for candidate in folder.iterdir():
        if candidate.is_file() and candidate.suffix.lower() in VIDEO_EXTENSIONS:
            return candidate
    return None


def download(url: str, destination: Path, dry_run: bool) -> bool:
    if destination.exists() and destination.stat().st_size > 0:
        print(f"  ya existe: {destination}")
        return False
    if dry_run:
        print(f"  descargaría: {url}")
        print(f"  destino:     {destination}")
        return True

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    print(f"  descargando: {url}")
    curl = shutil.which("curl")
    if curl:
        command = [
            curl, "-L", "--fail", "--retry", "3", "--retry-delay", "3",
            "--continue-at", "-", "--user-agent", USER_AGENT, "-o", str(partial), url,
        ]
        result = subprocess.run(command)
        if result.returncode != 0:
            raise RuntimeError(f"curl terminó con código {result.returncode}")
        partial.replace(destination)
        print(f"  listo: {destination}")
        return True

    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, open(partial, "wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        partial.replace(destination)
        print(f"  listo: {destination}")
        return True
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def process(kind: str, query: str, limit: int, scan_limit: int, max_bytes: int, output: Path, dry_run: bool, prefer_small: bool = False) -> int:
    print(f"\n== {kind.upper()} ==")
    docs = ia_search(query, scan_limit)
    print(f"Candidatos revisados: {len(docs)}")
    downloaded = 0

    for doc in docs:
        if downloaded >= limit:
            break
        identifier = doc.get("identifier")
        if not identifier:
            continue
        try:
            metadata = fetch_json(IA_METADATA.format(identifier=urllib.parse.quote(identifier)))
        except Exception as exc:  # noqa: BLE001
            print(f"- {identifier}: no pude leer metadatos ({exc})")
            continue

        info = metadata.get("metadata") or {}
        license_url = first(info.get("licenseurl") or doc.get("licenseurl")).lower()
        if "publicdomain" not in license_url:
            continue
        if not (metadata.get("files") or []):
            continue

        title = safe_name(first(info.get("title") or doc.get("title") or identifier))
        year = first(info.get("year") or doc.get("year"))
        if any(word in title.lower() for word in BLOCKED_TITLE_WORDS):
            print(f"- {title}: bloqueado por título no apto")
            continue
        video = choose_video(metadata.get("files") or [], max_bytes, prefer_small)
        if not video:
            print(f"- {title}: sin vídeo por debajo de {max_bytes // (1024 * 1024)} MiB")
            continue

        suffix = Path(video).suffix.lower()
        url = IA_DOWNLOAD.format(identifier=urllib.parse.quote(identifier), file=urllib.parse.quote(video))

        if kind == "movie":
            base = title_year(title, year)
            destination = output / "movies" / base / f"{base}{suffix}"
        else:
            parsed = parse_episode(title)
            if not parsed:
                print(f"- {title}: no parece episodio con SxxExx, lo salto")
                continue
            series, season, episode, episode_title = parsed
            series = title_year(series, year)
            season_dir = f"Season {season:02d}"
            episode_name = safe_name(episode_title or f"Episodio {episode}")
            filename = f"{series} - S{season:02d}E{episode:03d}"
            if episode_title:
                filename += f" - {episode_name}"
            destination = output / "tv" / series / season_dir / f"{filename}{suffix}"

        if kind == "movie":
            existing = existing_video(destination.parent)
            if existing:
                print(f"- {title}: ya hay vídeo en la carpeta ({existing.name})")
                continue

        print(f"- {title} ({video})")
        try:
            if download(url, destination, dry_run):
                downloaded += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR descargando {title}: {exc}")

    print(f"Total {kind}: {downloaded}")
    return downloaded


def main() -> int:
    parser = argparse.ArgumentParser(description="Descarga catálogo legal de Internet Archive.")
    parser.add_argument("--type", choices=["movie", "series", "all"], default="all")
    parser.add_argument("--limit", type=int, default=5, help="máximo por tipo (por defecto 5)")
    parser.add_argument("--scan-limit", type=int, default=100, help="candidatos a revisar (máx. 100)")
    parser.add_argument("--max-size-mb", type=int, default=1500, help="tamaño máximo por archivo")
    parser.add_argument("--prefer-small", action="store_true", help="preferir archivos pequeños (más rápido)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--apply", action="store_true", help="descargar de verdad")
    parser.add_argument("--dry-run", action="store_true", help="solo mostrar (por defecto)")
    args = parser.parse_args()

    dry_run = not args.apply
    max_bytes = max(1, args.max_size_mb) * 1024 * 1024
    output = args.output.resolve()

    print("Pepflix · catálogo legal de dominio público")
    print(f"Salida: {output}")
    print(f"Modo: {'simulación' if dry_run else 'DESCARGA REAL'}")
    print(f"Límite: {args.limit} por tipo · máx. {args.max_size_mb} MiB por archivo")

    total = 0
    if args.type in ("movie", "all"):
        total += process("movie", MOVIE_QUERY, args.limit, args.scan_limit, max_bytes, output, dry_run, args.prefer_small)
    if args.type in ("series", "all"):
        total += process("series", SERIES_QUERY, args.limit, args.scan_limit, max_bytes, output, dry_run, args.prefer_small)

    print(f"\nTotal descargado: {total}")
    if dry_run:
        print("Simulación terminada. Usa --apply para descargar.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
