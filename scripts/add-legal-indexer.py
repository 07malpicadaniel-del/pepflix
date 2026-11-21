#!/usr/bin/env python3
"""Añade a Prowlarr un indexador legal usando la URL de su interfaz.

Solo acepta hosts de la lista blanca (dominio público / legal). No intenta
inventar definiciones: busca una definición que Prowlarr ya traiga instalada.

Uso:
    ./scripts/add-legal-indexer.py --url https://archive.org/
    ./scripts/add-legal-indexer.py --url https://linuxtracker.org/ --apply
    ./scripts/add-legal-indexer.py --list

Por defecto solo muestra lo que haría. Para añadirlo de verdad, usa --apply.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ALLOWED_HOSTS = {"archive.org", "linuxtracker.org"}
DEFAULT_CONFIG_PATHS = [
    ROOT / "local-storage/appdata/prowlarr/config/config.xml",
    Path("/home/daniel/media-stack/config/prowlarr/config.xml"),
]


def allowed_hosts() -> set[str]:
    extra = os.environ.get("LEGAL_INDEXER_HOSTS", "")
    hosts = set(DEFAULT_ALLOWED_HOSTS)
    for item in extra.split(","):
        item = item.strip().lower()
        if item:
            hosts.add(item)
    return hosts


def find_api_key(explicit: str | None) -> str:
    if explicit:
        return explicit.strip()
    env = os.environ.get("PROWLARR_API_KEY", "").strip()
    if env:
        return env
    for path in DEFAULT_CONFIG_PATHS:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        match = re.search(r"<ApiKey>([^<]+)</ApiKey>", text)
        if match:
            return match.group(1).strip()
    return ""


def request(base: str, api_key: str, path: str, method: str = "GET", payload=None):
    body = None
    headers = {"X-Api-Key": api_key, "Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base.rstrip("/") + path, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.status, response.read()


def normalize_host(value: str) -> str:
    parsed = urllib.parse.urlparse(value if "://" in value else "https://" + value)
    return (parsed.hostname or "").lower()


def schema_urls(item: dict) -> list[str]:
    urls = list(item.get("indexerUrls") or [])
    urls.extend(item.get("legacyUrls") or [])
    return [u for u in urls if u]


def matches_url(item: dict, host: str) -> bool:
    for url in schema_urls(item):
        if normalize_host(url) == host:
            return True
    return False


def build_payload(item: dict, app_profile_id: int, base_url: str) -> dict:
    payload = {
        "name": item.get("name"),
        "implementation": item.get("implementation"),
        "implementationName": item.get("implementationName") or item.get("implementation"),
        "configContract": item.get("configContract"),
        "infoLink": item.get("infoLink") or (item.get("indexerUrls") or [""])[0],
        "message": None,
        "tags": [],
        "fields": item.get("fields", []),
        "priority": item.get("priority", 25),
        "appProfileId": app_profile_id,
        "enable": True,
        "protocol": item.get("protocol", "torrent"),
        "privacy": item.get("privacy", "public"),
        "supportsRss": item.get("supportsRss", True),
        "supportsSearch": item.get("supportsSearch", True),
        "supportsRedirect": item.get("supportsRedirect", False),
        "supportsPagination": item.get("supportsPagination", False),
        "definitionName": item.get("definitionName"),
        "description": item.get("description"),
        "language": item.get("language"),
        "indexerUrls": item.get("indexerUrls", []),
        "legacyUrls": item.get("legacyUrls", []),
    }
    for field in payload["fields"]:
        name = field.get("name")
        if name == "definitionFile":
            field["value"] = item.get("definitionName")
        elif name == "baseUrl":
            field["value"] = base_url
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Añade indexadores legales a Prowlarr por URL.")
    parser.add_argument("--url", help="URL de la interfaz del indexador (ej. https://archive.org/)")
    parser.add_argument("--apply", action="store_true", help="Añadir de verdad (sin esto solo simula)")
    parser.add_argument("--list", action="store_true", help="Listar indexadores legales disponibles")
    parser.add_argument("--prowlarr-url", default=os.environ.get("PROWLARR_URL", "http://127.0.0.1:9696"))
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--app-profile-id", type=int, default=None)
    args = parser.parse_args()

    if not args.list and not args.url:
        parser.error("indica --url o usa --list")

    api_key = find_api_key(args.api_key)
    if not api_key:
        print("ERROR: no encontré la API key de Prowlarr. Usa --api-key o PROWLARR_API_KEY.", file=sys.stderr)
        return 2

    hosts = allowed_hosts()
    try:
        status, body = request(args.prowlarr_url, api_key, "/api/v1/indexer/schema")
        if status != 200:
            print(f"ERROR: Prowlarr respondió {status}.", file=sys.stderr)
            return 2
        schema = json.loads(body)
        status, body = request(args.prowlarr_url, api_key, "/api/v1/indexer")
        if status != 200:
            print(f"ERROR: Prowlarr respondió {status}.", file=sys.stderr)
            return 2
        existing = json.loads(body)
    except urllib.error.HTTPError as exc:
        print(f"ERROR HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:500]}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - mensaje claro para el usuario
        print(f"ERROR conectando con Prowlarr: {exc}", file=sys.stderr)
        return 2

    candidates = [item for item in schema if any(normalize_host(u) in hosts for u in schema_urls(item))]

    if args.list:
        print("Hosts permitidos:")
        for host in sorted(hosts):
            print(f"  - {host}")
        print("\nDefiniciones legales disponibles en Prowlarr:")
        for item in sorted(candidates, key=lambda x: (x.get("name") or "").lower()):
            print(f"  - {item.get('name')}  ({', '.join(schema_urls(item))})")
        return 0

    host = normalize_host(args.url)
    if host not in hosts:
        print(f"ERROR: '{host}' no está en la lista blanca legal.", file=sys.stderr)
        print(f"Hosts permitidos: {', '.join(sorted(hosts))}", file=sys.stderr)
        print("Puedes ampliarla con LEGAL_INDEXER_HOSTS=dominio1,dominio2", file=sys.stderr)
        return 2

    matches = [item for item in schema if matches_url(item, host)]
    if not matches:
        print(f"ERROR: Prowlarr no tiene una definición instalada para '{host}'.", file=sys.stderr)
        print("Actualiza Prowlarr o usa un indexador de la lista con --list.", file=sys.stderr)
        return 2
    if len(matches) > 1:
        print("Hay varias definiciones para ese host:", file=sys.stderr)
        for item in matches:
            print(f"  - {item.get('name')}", file=sys.stderr)
        print("Usa la URL exacta o añade el indexador desde la interfaz de Prowlarr.", file=sys.stderr)
        return 2

    item = matches[0]
    name = item.get("name") or host
    for current in existing:
        if current.get("definitionName") == item.get("definitionName") or current.get("name") == name:
            print(f"Ya existe en Prowlarr: {current.get('name')} (id {current.get('id')}).")
            return 0

    if args.app_profile_id is None:
        try:
            _, profiles_body = request(args.prowlarr_url, api_key, "/api/v1/appprofile")
            profiles = json.loads(profiles_body)
            app_profile_id = profiles[0]["id"] if profiles else 1
        except Exception:  # noqa: BLE001
            app_profile_id = 1
    else:
        app_profile_id = args.app_profile_id

    payload = build_payload(item, app_profile_id, args.url.rstrip("/") + "/")

    print(f"Indexador: {name}")
    print(f"URL:       {args.url}")
    print(f"Definición: {item.get('definitionName')}")
    print(f"App profile: {app_profile_id}")
    if not args.apply:
        print("\nSimulación. Vuelve a ejecutar con --apply para añadirlo.")
        return 0

    try:
        status, body = request(args.prowlarr_url, api_key, "/api/v1/indexer", "POST", payload)
        print(f"Añadido (HTTP {status}).")
        result = json.loads(body)
        print(f"ID: {result.get('id')}  Nombre: {result.get('name')}")
        print("Prowlarr lo sincronizará con Radarr/Sonarr según su configuración de Apps.")
        return 0
    except urllib.error.HTTPError as exc:
        print(f"ERROR HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:1500]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
