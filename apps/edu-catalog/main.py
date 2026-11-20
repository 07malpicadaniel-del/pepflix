"""
Módulo 6 — Centro de Documentales y Contenido Educativo
Microservicio ligero FastAPI + SQLite (optimizado para Raspberry Pi ARM64).
Catálogo exclusivamente legal: dominio público, Creative Commons, NASA, MIT OCW,
Internet Archive y Wikimedia Commons.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DB_PATH = Path(os.getenv("EDU_DB_PATH", "/data/edu_catalog.db"))
SEED_PATH = Path(os.getenv("EDU_SEED_PATH", str(APP_DIR / "seed_data.json")))


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db_and_seed() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                category TEXT NOT NULL,
                theme TEXT NOT NULL,
                language TEXT NOT NULL,
                duration_minutes INTEGER NOT NULL,
                year INTEGER,
                source TEXT NOT NULL,
                license TEXT NOT NULL,
                source_url TEXT NOT NULL,
                format TEXT DEFAULT 'Vídeo',
                tags TEXT DEFAULT '[]',
                watched INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS favorites (
                item_id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
            CREATE INDEX IF NOT EXISTS idx_items_theme ON items(theme);
            CREATE INDEX IF NOT EXISTS idx_items_language ON items(language);
            CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
            """
        )

        if SEED_PATH.exists():
            seed_items = json.loads(SEED_PATH.read_text(encoding="utf-8"))
            now = datetime.now(timezone.utc).isoformat()
            for entry in seed_items:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO items (
                        slug, title, description, category, theme, language,
                        duration_minutes, year, source, license, source_url,
                        format, tags, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry["slug"],
                        entry["title"],
                        entry["description"],
                        entry["category"],
                        entry["theme"],
                        entry["language"],
                        int(entry["duration_minutes"]),
                        entry.get("year"),
                        entry["source"],
                        entry["license"],
                        entry["source_url"],
                        entry.get("format", "Vídeo"),
                        json.dumps(entry.get("tags", []), ensure_ascii=False),
                        now,
                    ),
                )


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    try:
        data["tags"] = json.loads(data.get("tags") or "[]")
    except json.JSONDecodeError:
        data["tags"] = []
    data["is_favorite"] = bool(data.get("is_favorite", 0))
    data["watched"] = bool(data.get("watched", 0))
    return data


def slugify(value: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return clean[:64] or "recurso-educativo"


# --- Esquemas Pydantic ---
class ItemCreate(BaseModel):
    title: str = Field(..., min_length=3, max_length=200)
    description: str = Field(..., min_length=10, max_length=1200)
    category: str = Field(..., min_length=2, max_length=60)
    theme: str = Field(..., min_length=2, max_length=80)
    language: str = Field(..., pattern="^(es|en|multilingual)$")
    duration_minutes: int = Field(..., ge=1, le=20000)
    year: Optional[int] = Field(default=None, ge=1890, le=2100)
    source: str = Field(..., min_length=2, max_length=100)
    license: str = Field(..., min_length=2, max_length=80)
    source_url: str = Field(..., min_length=10, max_length=500)
    format: str = Field(default="Vídeo", max_length=60)
    tags: list[str] = Field(default_factory=list)

    @field_validator("source_url")
    @classmethod
    def validate_http_url(cls, v: str) -> str:
        if not (v.startswith("https://") or v.startswith("http://")):
            raise ValueError("La URL de origen debe comenzar por http:// o https://")
        return v.strip()


class ItemStatusUpdate(BaseModel):
    watched: Optional[bool] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db_and_seed()
    yield


app = FastAPI(
    title="Homelab Edu & Documentary Catalog",
    description="Centro autohospedado de documentales y recursos educativos gratuitos y legales.",
    version="1.0.0",
    lifespan=lifespan,
)


# --- Endpoints de Salud y Estadísticas ---
@app.get("/healthz")
def healthz() -> dict[str, str]:
    with get_db() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"status": "ok"}


@app.get("/api/stats")
def get_stats() -> dict[str, Any]:
    with get_db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        favorites = conn.execute("SELECT COUNT(*) FROM favorites").fetchone()[0]
        watched = conn.execute("SELECT COUNT(*) FROM items WHERE watched = 1").fetchone()[0]
        sources = conn.execute("SELECT COUNT(DISTINCT source) FROM items").fetchone()[0]
    return {
        "total_items": total,
        "favorites": favorites,
        "watched": watched,
        "sources": sources,
    }


@app.get("/api/facets")
def get_facets() -> dict[str, Any]:
    with get_db() as conn:
        categories = [r[0] for r in conn.execute("SELECT DISTINCT category FROM items ORDER BY category")]
        themes = [r[0] for r in conn.execute("SELECT DISTINCT theme FROM items ORDER BY theme")]
        languages = [r[0] for r in conn.execute("SELECT DISTINCT language FROM items ORDER BY language")]
        sources = [r[0] for r in conn.execute("SELECT DISTINCT source FROM items ORDER BY source")]
    return {
        "categories": categories,
        "themes": themes,
        "languages": languages,
        "sources": sources,
        "duration_buckets": [
            {"id": "short", "label": "Corto (< 30 min)"},
            {"id": "medium", "label": "Medio (30 - 90 min)"},
            {"id": "long", "label": "Largo / Curso (> 90 min)"},
        ],
    }


# --- CRUD del Catálogo ---
def _query_items(
    *,
    q: Optional[str] = None,
    category: Optional[str] = None,
    theme: Optional[str] = None,
    language: Optional[str] = None,
    source: Optional[str] = None,
    duration_bucket: Optional[str] = None,
    favorites_only: bool = False,
    watched_only: bool = False,
    sort: str = "title",
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []

    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        clauses.append(
            "(LOWER(i.title) LIKE ? OR LOWER(i.description) LIKE ? OR LOWER(i.tags) LIKE ? OR LOWER(i.source) LIKE ?)"
        )
        params.extend([like, like, like, like])

    if category:
        clauses.append("i.category = ?")
        params.append(category)

    if theme:
        clauses.append("i.theme = ?")
        params.append(theme)

    if language:
        clauses.append("i.language = ?")
        params.append(language)

    if source:
        clauses.append("i.source = ?")
        params.append(source)

    if duration_bucket == "short":
        clauses.append("i.duration_minutes < 30")
    elif duration_bucket == "medium":
        clauses.append("i.duration_minutes >= 30 AND i.duration_minutes <= 90")
    elif duration_bucket == "long":
        clauses.append("i.duration_minutes > 90")

    if favorites_only:
        clauses.append("f.item_id IS NOT NULL")

    if watched_only:
        clauses.append("i.watched = 1")

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    order_map = {
        "title": "i.title COLLATE NOCASE ASC",
        "year_desc": "COALESCE(i.year, 0) DESC, i.title ASC",
        "duration_asc": "i.duration_minutes ASC, i.title ASC",
        "duration_desc": "i.duration_minutes DESC, i.title ASC",
        "recent": "i.id DESC",
    }
    order_sql = order_map[sort]

    sql = f"""
        SELECT i.*, CASE WHEN f.item_id IS NOT NULL THEN 1 ELSE 0 END AS is_favorite
        FROM items i
        LEFT JOIN favorites f ON f.item_id = i.id
        {where_sql}
        ORDER BY {order_sql}
    """

    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()

    items = [row_to_dict(r) for r in rows]
    return {"count": len(items), "items": items}


@app.get("/api/items")
def list_items(
    q: Optional[str] = Query(default=None, description="Búsqueda por título, descripción o etiquetas"),
    category: Optional[str] = Query(default=None),
    theme: Optional[str] = Query(default=None),
    language: Optional[str] = Query(default=None),
    source: Optional[str] = Query(default=None),
    duration_bucket: Optional[str] = Query(default=None, pattern="^(short|medium|long)$"),
    favorites_only: bool = Query(default=False),
    watched_only: bool = Query(default=False),
    sort: str = Query(default="title", pattern="^(title|year_desc|duration_asc|duration_desc|recent)$"),
) -> dict[str, Any]:
    return _query_items(
        q=q,
        category=category,
        theme=theme,
        language=language,
        source=source,
        duration_bucket=duration_bucket,
        favorites_only=favorites_only,
        watched_only=watched_only,
        sort=sort,
    )


@app.get("/api/items/{item_id}")
def get_item(item_id: int) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT i.*, CASE WHEN f.item_id IS NOT NULL THEN 1 ELSE 0 END AS is_favorite
            FROM items i
            LEFT JOIN favorites f ON f.item_id = i.id
            WHERE i.id = ?
            """,
            (item_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Recurso no encontrado")
    return row_to_dict(row)


@app.post("/api/items", status_code=201)
def create_item(payload: ItemCreate) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    base_slug = slugify(payload.title)
    clean_tags = [t.strip().lower() for t in payload.tags if t.strip()][:12]

    with get_db() as conn:
        slug = base_slug
        suffix = 1
        while conn.execute("SELECT 1 FROM items WHERE slug = ?", (slug,)).fetchone():
            suffix += 1
            slug = f"{base_slug}-{suffix}"

        cur = conn.execute(
            """
            INSERT INTO items (
                slug, title, description, category, theme, language,
                duration_minutes, year, source, license, source_url,
                format, tags, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                slug,
                payload.title.strip(),
                payload.description.strip(),
                payload.category.strip(),
                payload.theme.strip(),
                payload.language,
                payload.duration_minutes,
                payload.year,
                payload.source.strip(),
                payload.license.strip(),
                payload.source_url,
                payload.format.strip(),
                json.dumps(clean_tags, ensure_ascii=False),
                now,
            ),
        )
        new_id = cur.lastrowid
        row = conn.execute(
            "SELECT *, 0 AS is_favorite FROM items WHERE id = ?", (new_id,)
        ).fetchone()
    return row_to_dict(row)


@app.patch("/api/items/{item_id}/status")
def update_item_status(item_id: int, payload: ItemStatusUpdate) -> dict[str, Any]:
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Recurso no encontrado")

        if payload.watched is not None:
            conn.execute(
                "UPDATE items SET watched = ? WHERE id = ?",
                (1 if payload.watched else 0, item_id),
            )
        if payload.notes is not None:
            conn.execute(
                "UPDATE items SET notes = ? WHERE id = ?",
                (payload.notes.strip(), item_id),
            )

        row = conn.execute(
            """
            SELECT i.*, CASE WHEN f.item_id IS NOT NULL THEN 1 ELSE 0 END AS is_favorite
            FROM items i
            LEFT JOIN favorites f ON f.item_id = i.id
            WHERE i.id = ?
            """,
            (item_id,),
        ).fetchone()
    return row_to_dict(row)


# --- Favoritos persistentes en SQLite ---
@app.get("/api/favorites")
def list_favorites() -> dict[str, Any]:
    return _query_items(favorites_only=True)


@app.post("/api/favorites/{item_id}")
def add_favorite(item_id: int) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        exists = conn.execute("SELECT id FROM items WHERE id = ?", (item_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Recurso no encontrado")
        conn.execute(
            "INSERT OR IGNORE INTO favorites (item_id, created_at) VALUES (?, ?)",
            (item_id, now),
        )
    return {"item_id": item_id, "is_favorite": True}


@app.delete("/api/favorites/{item_id}")
def remove_favorite(item_id: int) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute("DELETE FROM favorites WHERE item_id = ?", (item_id,))
    return {"item_id": item_id, "is_favorite": False}


# --- Archivos estáticos y SPA ---
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
