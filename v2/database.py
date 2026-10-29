from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Sequence

from .models import Lead
from .niches import normalize


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def niche_key(niche: str) -> str:
    return hashlib.sha256(normalize(niche).encode("utf-8")).hexdigest()


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migration_lock = threading.Lock()
        self.migrate()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=20)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=20000")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def migrate(self) -> None:
        with self._migration_lock, self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authorized_users (
                    user_id INTEGER PRIMARY KEY,
                    username TEXT COLLATE NOCASE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instagram_username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_hidden INTEGER NOT NULL DEFAULT 0,
                    hidden_at TEXT,
                    source_type TEXT NOT NULL DEFAULT 'instagram',
                    display_name TEXT
                );
                CREATE TABLE IF NOT EXISTS leads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instagram_username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    full_name TEXT,
                    instagram_url TEXT NOT NULL,
                    telegram_urls TEXT NOT NULL,
                    source_account TEXT NOT NULL,
                    keyword TEXT NOT NULL,
                    discovered_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_hidden INTEGER NOT NULL DEFAULT 0,
                    hidden_at TEXT,
                    followers_count INTEGER
                );
                CREATE TABLE IF NOT EXISTS source_leads (
                    source_id INTEGER NOT NULL,
                    lead_id INTEGER NOT NULL,
                    keyword TEXT NOT NULL,
                    discovered_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(source_id, lead_id),
                    FOREIGN KEY(source_id) REFERENCES sources(id),
                    FOREIGN KEY(lead_id) REFERENCES leads(id)
                );
                CREATE TABLE IF NOT EXISTS lead_telegram_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lead_id INTEGER NOT NULL,
                    telegram_urls TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    observation_source TEXT NOT NULL,
                    FOREIGN KEY(lead_id) REFERENCES leads(id)
                );
                CREATE INDEX IF NOT EXISTS idx_lead_telegram_history_lead
                    ON lead_telegram_history(lead_id,id);
                CREATE TABLE IF NOT EXISTS parse_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    target TEXT NOT NULL,
                    keyword TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    message_id INTEGER,
                    status TEXT NOT NULL DEFAULT 'queued',
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    error TEXT
                );
                CREATE TABLE IF NOT EXISTS auto_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    chat_id INTEGER NOT NULL,
                    niche TEXT NOT NULL,
                    niche_key TEXT NOT NULL UNIQUE,
                    min_followers INTEGER NOT NULL DEFAULT 2000,
                    max_followers INTEGER,
                    daily_goal INTEGER NOT NULL DEFAULT 20,
                    query_cursor INTEGER NOT NULL DEFAULT 0,
                    cooldown_until TEXT,
                    last_cycle_at TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auto_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    niche_key TEXT NOT NULL,
                    instagram_username TEXT NOT NULL COLLATE NOCASE,
                    source TEXT NOT NULL,
                    search_query TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    followers_count INTEGER,
                    full_name TEXT,
                    rejection_reason TEXT,
                    error TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    donor_attempted INTEGER NOT NULL DEFAULT 0,
                    donor_failures INTEGER NOT NULL DEFAULT 0,
                    is_russian INTEGER,
                    discovered_at TEXT NOT NULL,
                    checked_at TEXT,
                    UNIQUE(niche_key, instagram_username)
                );
                CREATE TABLE IF NOT EXISTS parser_v2_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_v2_source_visible
                    ON source_leads(source_id, lead_id);
                CREATE INDEX IF NOT EXISTS idx_v2_candidate_queue
                    ON auto_candidates(niche_key, status, id);
                CREATE TABLE IF NOT EXISTS crawl_nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    niche_key TEXT NOT NULL,
                    instagram_username TEXT NOT NULL COLLATE NOCASE,
                    followers_count INTEGER,
                    full_name TEXT,
                    qualified INTEGER NOT NULL DEFAULT 0,
                    expanded INTEGER NOT NULL DEFAULT 0,
                    depth INTEGER NOT NULL DEFAULT 0,
                    discovered_from TEXT,
                    rejection_reason TEXT,
                    error TEXT,
                    discovered_at TEXT NOT NULL,
                    checked_at TEXT,
                    UNIQUE(niche_key,instagram_username)
                );
                CREATE TABLE IF NOT EXISTS crawl_claims (
                    niche_key TEXT NOT NULL,
                    instagram_username TEXT NOT NULL COLLATE NOCASE,
                    claim_kind TEXT NOT NULL,
                    worker_id TEXT NOT NULL,
                    claimed_at TEXT NOT NULL,
                    PRIMARY KEY(niche_key,instagram_username,claim_kind)
                );
                CREATE INDEX IF NOT EXISTS idx_crawl_claim_worker
                    ON crawl_claims(niche_key,worker_id,claim_kind);
                CREATE TABLE IF NOT EXISTS worker_runtime (
                    worker_id TEXT PRIMARY KEY,
                    niche_key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_worker_runtime_niche
                    ON worker_runtime(niche_key,updated_at);
                CREATE INDEX IF NOT EXISTS idx_crawl_next_donor
                    ON crawl_nodes(niche_key,qualified,expanded,followers_count DESC,id);
                CREATE TABLE IF NOT EXISTS remote_lead_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instagram_username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    niche TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            candidate_columns = {
                str(row[1]) for row in db.execute("PRAGMA table_info(auto_candidates)")
            }
            if "is_russian" not in candidate_columns:
                db.execute("ALTER TABLE auto_candidates ADD COLUMN is_russian INTEGER")
            if "donor_failures" not in candidate_columns:
                db.execute(
                    "ALTER TABLE auto_candidates ADD COLUMN donor_failures INTEGER NOT NULL DEFAULT 0"
                )
            db.execute(
                "UPDATE auto_candidates SET status='pending', error=NULL "
                "WHERE status IN ('checking','processing')"
            )
            db.execute(
                "UPDATE parse_queue SET status='queued', started_at=NULL "
                "WHERE status IN ('running','processing')"
            )
            # Rows belong to the previous process and must never make an
            # external health check believe that dead workers are alive.
            db.execute("DELETE FROM worker_runtime")
            # Preserve the pre-migration value before future profile refreshes
            # replace stale Telegram contacts with the latest exact observation.
            db.execute(
                """
                INSERT INTO lead_telegram_history(
                    lead_id,telegram_urls,observed_at,observation_source
                )
                SELECT l.id,l.telegram_urls,l.updated_at,'legacy_snapshot'
                FROM leads l
                WHERE NOT EXISTS(
                    SELECT 1 FROM lead_telegram_history h WHERE h.lead_id=l.id
                )
                """
            )
            db.commit()

    def owner(self, configured: int | None = None) -> int | None:
        if configured is not None:
            return configured
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key='owner_user_id'").fetchone()
        return int(row["value"]) if row else None

    def claim_owner(self, user_id: int) -> tuple[int, bool]:
        with self.transaction() as db:
            row = db.execute("SELECT value FROM settings WHERE key='owner_user_id'").fetchone()
            if row:
                return int(row["value"]), False
            db.execute(
                "INSERT INTO settings(key,value) VALUES('owner_user_id',?)",
                (str(user_id),),
            )
            return user_id, True

    def user_is_authorized(self, user_id: int) -> bool:
        with self.connect() as db:
            row = db.execute(
                "SELECT 1 FROM authorized_users WHERE user_id=?",
                (user_id,),
            ).fetchone()
        return row is not None

    def grant_access(self, user_id: int, username: str | None = None) -> None:
        now = utcnow()
        clean_username = (username or "").strip().lstrip("@") or None
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO authorized_users(user_id,username,created_at,updated_at)
                VALUES(?,?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET
                    username=COALESCE(excluded.username,authorized_users.username),
                    updated_at=excluded.updated_at
                """,
                (user_id, clean_username, now, now),
            )

    def categories(self) -> list[sqlite3.Row]:
        with self.connect() as db:
            return list(
                db.execute(
                    """
                    SELECT s.id,s.display_name,s.updated_at,COUNT(l.id) AS total
                    FROM sources s
                    LEFT JOIN source_leads sl ON sl.source_id=s.id
                    LEFT JOIN leads l ON l.id=sl.lead_id AND l.is_hidden=0
                    WHERE s.source_type='auto' AND s.is_hidden=0
                    GROUP BY s.id
                    HAVING COUNT(l.id)>0
                    ORDER BY s.updated_at DESC,s.id DESC
                    """
                )
            )

    def category(self, source_id: int) -> sqlite3.Row | None:
        with self.connect() as db:
            return db.execute(
                "SELECT * FROM sources WHERE id=? AND source_type='auto' AND is_hidden=0",
                (source_id,),
            ).fetchone()

    def category_count(self, source_id: int) -> int:
        with self.connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) total FROM source_leads sl
                JOIN leads l ON l.id=sl.lead_id
                WHERE sl.source_id=? AND l.is_hidden=0
                """,
                (source_id,),
            ).fetchone()
        return int(row["total"])

    def category_leads(self, source_id: int, offset: int, limit: int) -> list[sqlite3.Row]:
        with self.connect() as db:
            return list(
                db.execute(
                    """
                    SELECT l.* FROM source_leads sl
                    JOIN leads l ON l.id=sl.lead_id
                    WHERE sl.source_id=? AND l.is_hidden=0
                    ORDER BY sl.discovered_at ASC,l.id ASC
                    LIMIT ? OFFSET ?
                    """,
                    (source_id, limit, offset),
                )
            )

    def hide_lead(self, lead_id: int) -> bool:
        with self.transaction() as db:
            cursor = db.execute(
                "UPDATE leads SET is_hidden=1,hidden_at=?,updated_at=? "
                "WHERE id=? AND is_hidden=0",
                (utcnow(), utcnow(), lead_id),
            )
            return cursor.rowcount > 0

    def hide_category_range(self, source_id: int, first: int, last: int) -> int:
        """Hide an inclusive 1-based slice of the category's visible ordering."""
        if first < 1 or last < first:
            raise ValueError("Invalid category range")
        now = utcnow()
        limit = last - first + 1
        offset = first - 1
        with self.transaction() as db:
            rows = db.execute(
                """
                SELECT l.id FROM source_leads sl
                JOIN leads l ON l.id=sl.lead_id
                WHERE sl.source_id=? AND l.is_hidden=0
                ORDER BY sl.discovered_at ASC,l.id ASC
                LIMIT ? OFFSET ?
                """,
                (source_id, limit, offset),
            ).fetchall()
            lead_ids = [int(row["id"]) for row in rows]
            if not lead_ids:
                return 0
            placeholders = ",".join("?" for _ in lead_ids)
            cursor = db.execute(
                f"UPDATE leads SET is_hidden=1,hidden_at=?,updated_at=? "
                f"WHERE is_hidden=0 AND id IN ({placeholders})",
                (now, now, *lead_ids),
            )
            return cursor.rowcount

    def ensure_source(self, source_type: str, username: str, display_name: str | None) -> int:
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO sources(instagram_username,created_at,updated_at,source_type,display_name)
                VALUES(?,?,?,?,?)
                ON CONFLICT(instagram_username) DO UPDATE SET
                    updated_at=excluded.updated_at,
                    display_name=COALESCE(excluded.display_name,sources.display_name)
                """,
                (username, now, now, source_type, display_name),
            )
            row = db.execute(
                "SELECT id FROM sources WHERE instagram_username=? COLLATE NOCASE",
                (username,),
            ).fetchone()
            return int(row["id"])

    def ensure_auto_source(self, niche: str) -> int:
        key = niche_key(niche)
        username = f"auto_{key[:16]}"
        return self.ensure_source("auto", username, f"Автопоиск: {normalize(niche)}")

    @staticmethod
    def _telegram_payload(urls: Sequence[str]) -> str:
        unique: list[str] = []
        seen: set[str] = set()
        for value in urls:
            clean = str(value or "").strip()
            key = clean.casefold()
            if clean and key not in seen:
                unique.append(clean)
                seen.add(key)
        return json.dumps(unique, ensure_ascii=False)

    @staticmethod
    def _record_telegram_observation(
        db: sqlite3.Connection,
        lead_id: int,
        payload: str,
        observed_at: str,
        source: str,
    ) -> None:
        db.execute(
            """
            INSERT INTO lead_telegram_history(
                lead_id,telegram_urls,observed_at,observation_source
            ) VALUES(?,?,?,?)
            """,
            (lead_id, payload, observed_at, source),
        )

    @classmethod
    def _update_lead_observation(
        cls,
        db: sqlite3.Connection,
        existing: sqlite3.Row,
        lead: Lead,
        now: str,
        source: str,
    ) -> int:
        lead_id = int(existing["id"])
        payload = cls._telegram_payload(lead.telegram_urls)
        db.execute(
            """
            UPDATE leads
            SET full_name=?,instagram_url=?,telegram_urls=?,updated_at=?,followers_count=?
            WHERE id=?
            """,
            (
                lead.full_name or existing["full_name"],
                lead.instagram_url or existing["instagram_url"],
                payload,
                now,
                lead.followers if lead.followers is not None else existing["followers_count"],
                lead_id,
            ),
        )
        cls._record_telegram_observation(db, lead_id, payload, now, source)
        return lead_id

    def refresh_lead(self, lead: Lead, source: str = "profile_recheck") -> int | None:
        """Replace contacts for an existing lead with one exact profile observation.

        An empty tuple is meaningful: the profile was successfully read again,
        but no direct Telegram contact remained. New rows are never created here.
        """
        now = utcnow()
        with self.transaction() as db:
            existing = db.execute(
                "SELECT * FROM leads WHERE instagram_username=? COLLATE NOCASE",
                (lead.username,),
            ).fetchone()
            if existing is None:
                return None
            return self._update_lead_observation(db, existing, lead, now, source)

    def add_lead(self, source_id: int, niche: str, lead: Lead) -> tuple[bool, int]:
        now = utcnow()
        with self.transaction() as db:
            existing = db.execute(
                "SELECT * FROM leads WHERE instagram_username=? COLLATE NOCASE",
                (lead.username,),
            ).fetchone()
            if existing:
                lead_id = self._update_lead_observation(
                    db, existing, lead, now, "profile_rediscovery",
                )
                return False, lead_id
            payload = self._telegram_payload(lead.telegram_urls)
            cursor = db.execute(
                """
                INSERT INTO leads(
                    instagram_username,full_name,instagram_url,telegram_urls,
                    source_account,keyword,discovered_at,updated_at,followers_count
                ) VALUES(?,?,?,?,?,?,?,?,?)
                """,
                (
                    lead.username, lead.full_name, lead.instagram_url,
                    payload,
                    f"source:{source_id}", niche, now, now, lead.followers,
                ),
            )
            lead_id = int(cursor.lastrowid)
            self._record_telegram_observation(
                db, lead_id, payload, now, "profile_discovery",
            )
            db.execute(
                "INSERT INTO source_leads(source_id,lead_id,keyword,discovered_at,updated_at) "
                "VALUES(?,?,?,?,?)",
                (source_id, lead_id, niche, now, now),
            )
            db.execute("UPDATE sources SET updated_at=? WHERE id=?", (now, source_id))
            return True, lead_id

    def configure_auto(
        self,
        chat_id: int,
        niche: str,
        min_followers: int,
        max_followers: int | None,
    ) -> sqlite3.Row:
        clean = normalize(niche)
        key = niche_key(clean)
        now = utcnow()
        self.ensure_auto_source(clean)
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO auto_jobs(
                    enabled,chat_id,niche,niche_key,min_followers,max_followers,updated_at
                ) VALUES(1,?,?,?,?,?,?)
                ON CONFLICT(niche_key) DO UPDATE SET
                    enabled=1,chat_id=excluded.chat_id,niche=excluded.niche,
                    min_followers=excluded.min_followers,max_followers=excluded.max_followers,
                    cooldown_until=NULL,updated_at=excluded.updated_at
                """,
                (chat_id, clean, key, min_followers, max_followers, now),
            )
            return db.execute("SELECT * FROM auto_jobs WHERE niche_key=?", (key,)).fetchone()

    def auto_jobs(self, enabled_only: bool = False) -> list[sqlite3.Row]:
        sql = "SELECT * FROM auto_jobs"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY id"
        with self.connect() as db:
            return list(db.execute(sql))

    def set_cooldown(self, key: str, until: str | None) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE auto_jobs SET cooldown_until=?,last_cycle_at=?,updated_at=? WHERE niche_key=?",
                (until, utcnow(), utcnow(), key),
            )

    def set_auto_enabled(self, enabled: bool, key: str | None = None) -> int:
        with self.transaction() as db:
            if key:
                cursor = db.execute(
                    "UPDATE auto_jobs SET enabled=?,updated_at=? WHERE niche_key=?",
                    (int(enabled), utcnow(), key),
                )
            else:
                cursor = db.execute(
                    "UPDATE auto_jobs SET enabled=?,updated_at=?",
                    (int(enabled), utcnow()),
                )
            return cursor.rowcount

    def next_query(self, key: str, modulo: int) -> int:
        with self.transaction() as db:
            row = db.execute(
                "SELECT query_cursor FROM auto_jobs WHERE niche_key=?",
                (key,),
            ).fetchone()
            cursor = int(row["query_cursor"] if row else 0)
            db.execute(
                "UPDATE auto_jobs SET query_cursor=?,last_cycle_at=?,updated_at=? WHERE niche_key=?",
                (cursor + 1, utcnow(), utcnow(), key),
            )
            return cursor % max(1, modulo)

    def crawl_seen(self, key: str) -> set[str]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT instagram_username FROM crawl_nodes WHERE niche_key=?",
                (key,),
            ).fetchall()
        return {str(row["instagram_username"]).casefold() for row in rows}

    def record_crawl_node(
        self,
        key: str,
        username: str,
        followers: int | None,
        full_name: str,
        qualified: bool,
        depth: int,
        discovered_from: str | None,
        reason: str | None = None,
        error: str | None = None,
    ) -> bool:
        clean = username.casefold().strip().lstrip("@")
        if not clean:
            return False
        now = utcnow()
        with self.transaction() as db:
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO crawl_nodes(
                    niche_key,instagram_username,followers_count,full_name,qualified,
                    depth,discovered_from,rejection_reason,error,discovered_at,checked_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    key, clean, followers, full_name, int(qualified), max(0, depth),
                    discovered_from, reason[:500] if reason else None,
                    error[:500] if error else None, now, now,
                ),
            )
            return cursor.rowcount > 0

    def crawl_top_donors(self, key: str, limit: int = 3) -> list[sqlite3.Row]:
        with self.connect() as db:
            return list(db.execute(
                """
                WITH branch AS (
                    SELECT child.discovered_from AS parent, COUNT(*) AS checked,
                           SUM(CASE WHEN lead.id IS NOT NULL
                             AND child.rejection_reason IS NULL
                             AND child.error IS NULL THEN 1 ELSE 0 END) AS added
                    FROM crawl_nodes child
                    LEFT JOIN leads lead ON lead.instagram_username=child.instagram_username COLLATE NOCASE
                    WHERE child.niche_key=? AND child.followers_count IS NOT NULL
                      AND child.error IS NULL GROUP BY child.discovered_from
                )
                SELECT node.* FROM crawl_nodes node
                LEFT JOIN branch ON branch.parent=node.discovered_from
                WHERE node.niche_key=? AND node.qualified=1 AND node.expanded=0
                ORDER BY (COALESCE(branch.added,0)+1.0)/(COALESCE(branch.checked,0)+10.0) DESC,
                EXISTS (
                    SELECT 1 FROM leads lead
                    WHERE lead.instagram_username=node.instagram_username COLLATE NOCASE
                      AND lead.telegram_urls NOT IN ('', '[]')
                ) DESC,node.depth ASC,node.followers_count DESC,node.id ASC
                LIMIT ?
                """,
                (key, key, max(1, limit)),
            ))

    def claim_crawl_donor(self, key: str, worker_id: str) -> sqlite3.Row | None:
        """Atomically reserve one donor for one browser worker."""
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                "DELETE FROM crawl_claims WHERE claim_kind='donor' AND claimed_at<?",
                (cutoff,),
            )
            row = db.execute(
                """
                WITH branch AS (
                    SELECT child.discovered_from AS parent, COUNT(*) AS checked,
                           SUM(CASE WHEN lead.id IS NOT NULL
                             AND child.rejection_reason IS NULL
                             AND child.error IS NULL THEN 1 ELSE 0 END) AS added
                    FROM crawl_nodes child
                    LEFT JOIN leads lead ON lead.instagram_username=child.instagram_username COLLATE NOCASE
                    WHERE child.niche_key=? AND child.followers_count IS NOT NULL
                      AND child.error IS NULL GROUP BY child.discovered_from
                )
                SELECT node.* FROM crawl_nodes node
                LEFT JOIN branch ON branch.parent=node.discovered_from
                WHERE node.niche_key=? AND node.qualified=1 AND node.expanded=0
                  AND NOT EXISTS (
                    SELECT 1 FROM crawl_claims claim
                    WHERE claim.niche_key=node.niche_key
                      AND claim.instagram_username=node.instagram_username
                      AND claim.claim_kind='donor'
                  )
                ORDER BY (COALESCE(branch.added,0)+1.0)/(COALESCE(branch.checked,0)+10.0) DESC,
                EXISTS (
                    SELECT 1 FROM leads lead
                    WHERE lead.instagram_username=node.instagram_username COLLATE NOCASE
                      AND lead.telegram_urls NOT IN ('', '[]')
                ) DESC,node.depth ASC,node.followers_count DESC,node.id ASC
                LIMIT 1
                """,
                (key, key),
            ).fetchone()
            if row is None:
                return None
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO crawl_claims(
                    niche_key,instagram_username,claim_kind,worker_id,claimed_at
                ) VALUES(?,?, 'donor',?,?)
                """,
                (key, str(row["instagram_username"]), worker_id, now),
            )
            return row if cursor.rowcount else None

    def claim_crawl_retry(self, key: str, worker_id: str) -> sqlite3.Row | None:
        """Reserve one unread profile after ten minutes, at most twice."""
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        with self.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS crawl_retry_attempts (
                niche_key TEXT NOT NULL, instagram_username TEXT NOT NULL COLLATE NOCASE,
                attempts INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(niche_key,instagram_username))''')
            row = db.execute('''
                SELECT node.* FROM crawl_nodes node
                LEFT JOIN crawl_retry_attempts retry
                  ON retry.niche_key=node.niche_key AND retry.instagram_username=node.instagram_username
                WHERE node.niche_key=? AND node.qualified=0
                  AND node.rejection_reason='не прочитано число подписчиков'
                  AND node.checked_at<=? AND COALESCE(retry.attempts,0)<2
                  AND NOT EXISTS (SELECT 1 FROM crawl_claims claim
                      WHERE claim.niche_key=node.niche_key
                        AND claim.instagram_username=node.instagram_username)
                ORDER BY node.checked_at ASC,node.id ASC LIMIT 1
            ''', (key, cutoff)).fetchone()
            if row is None:
                return None
            username = str(row['instagram_username'])
            db.execute('''INSERT INTO crawl_retry_attempts VALUES(?,?,1)
                ON CONFLICT(niche_key,instagram_username) DO UPDATE SET attempts=attempts+1''',
                (key, username))
            db.execute("INSERT INTO crawl_claims VALUES(?,?,'candidate',?,?)",
                       (key, username, worker_id, utcnow()))
            db.execute('DELETE FROM crawl_nodes WHERE niche_key=? AND instagram_username=?',
                       (key, username))
            return row

    def claim_crawl_candidate(self, key: str, username: str, worker_id: str) -> bool:
        """Prevent two browser accounts from inspecting the same profile."""
        clean = username.casefold().strip().lstrip("@")
        if not clean:
            return False
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        with self.transaction() as db:
            if db.execute(
                "SELECT 1 FROM crawl_nodes WHERE niche_key=? AND instagram_username=? COLLATE NOCASE",
                (key, clean),
            ).fetchone():
                return False
            db.execute(
                "DELETE FROM crawl_claims WHERE claim_kind='candidate' AND claimed_at<?",
                (cutoff,),
            )
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO crawl_claims(
                    niche_key,instagram_username,claim_kind,worker_id,claimed_at
                ) VALUES(?,?, 'candidate',?,?)
                """,
                (key, clean, worker_id, utcnow()),
            )
            return bool(cursor.rowcount)

    def release_crawl_claim(
        self, key: str, username: str, claim_kind: str, worker_id: str,
    ) -> None:
        with self.transaction() as db:
            db.execute(
                """
                DELETE FROM crawl_claims
                WHERE niche_key=? AND instagram_username=? COLLATE NOCASE
                  AND claim_kind=? AND worker_id=?
                """,
                (key, username, claim_kind, worker_id),
            )

    def touch_worker(self, worker_id: str, key: str, status: str) -> None:
        """Persist a per-browser heartbeat for the external supervisor."""
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO worker_runtime(worker_id,niche_key,status,updated_at)
                VALUES(?,?,?,?)
                ON CONFLICT(worker_id) DO UPDATE SET
                    niche_key=excluded.niche_key,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (worker_id, key, status, utcnow()),
            )

    def remove_worker(self, worker_id: str) -> None:
        with self.transaction() as db:
            db.execute("DELETE FROM worker_runtime WHERE worker_id=?", (worker_id,))

    def reset_crawl_queue(self, key: str) -> None:
        """Clear crawler work state without deleting leads or their history."""
        with self.transaction() as db:
            db.execute("DELETE FROM crawl_claims WHERE niche_key=?", (key,))
            db.execute("DELETE FROM crawl_nodes WHERE niche_key=?", (key,))
            db.execute("DELETE FROM auto_candidates WHERE niche_key=?", (key,))
            db.execute(
                "UPDATE auto_jobs SET query_cursor=0,last_cycle_at=NULL,updated_at=? WHERE niche_key=?",
                (utcnow(), key),
            )

    def revive_crawl_donor(self, key: str, preferred: Sequence[str] = ()) -> str | None:
        """Requeue an already qualified donor when its niche frontier is empty.

        Instagram's global search commonly exposes only the same five accounts.
        Once all five have been checked, revisiting the oldest qualified donor is
        more useful than polling the blank search drawer forever: its followers
        and following can contain new accounts, while lead uniqueness remains
        enforced by the leads table and crawl_seen.
        """
        cleaned = [
            username.casefold().strip().lstrip("@")
            for username in preferred
            if username and username.strip().lstrip("@")
        ]
        now = utcnow()
        # Reopening the same donor immediately after it produced no fresh
        # accounts creates a tight three-profile loop.  Let Instagram's graph
        # change before an expanded donor becomes eligible again.
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()
        with self.transaction() as db:
            row = None
            for username in dict.fromkeys(cleaned):
                row = db.execute(
                    """
                    SELECT instagram_username FROM crawl_nodes
                    WHERE niche_key=? AND instagram_username=? COLLATE NOCASE
                      AND qualified=1 AND expanded=1 AND checked_at<=?
                    LIMIT 1
                    """,
                    (key, username, cutoff),
                ).fetchone()
                if row is not None:
                    break
            if row is None:
                row = db.execute(
                    """
                    SELECT instagram_username FROM crawl_nodes
                    WHERE niche_key=? AND qualified=1 AND expanded=1
                      AND checked_at<=?
                    ORDER BY checked_at ASC,id ASC
                    LIMIT 1
                    """,
                    (key, cutoff),
                ).fetchone()
            if row is None:
                return None
            username = str(row["instagram_username"])
            db.execute(
                """
                UPDATE crawl_nodes
                SET expanded=0,error=NULL,checked_at=?
                WHERE niche_key=? AND instagram_username=? COLLATE NOCASE
                """,
                (now, key, username),
            )
            return username

    def mark_crawl_expanded(self, key: str, username: str, error: str | None = None) -> None:
        with self.transaction() as db:
            db.execute(
                """
                UPDATE crawl_nodes
                SET expanded=1,error=?,checked_at=?
                WHERE niche_key=? AND instagram_username=? COLLATE NOCASE
                """,
                (error[:500] if error else None, utcnow(), key, username),
            )

    def crawl_counts(self, key: str) -> dict[str, int]:
        with self.connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) total,
                       SUM(CASE WHEN qualified=1 THEN 1 ELSE 0 END) qualified,
                       SUM(CASE WHEN qualified=1 AND expanded=0 THEN 1 ELSE 0 END) waiting
                FROM crawl_nodes WHERE niche_key=?
                """,
                (key,),
            ).fetchone()
        return {
            "total": int(row["total"] or 0),
            "qualified": int(row["qualified"] or 0),
            "waiting": int(row["waiting"] or 0),
        }

    def enqueue_candidates(
        self,
        key: str,
        usernames: Sequence[str],
        source: str,
        query: str,
    ) -> int:
        added = 0
        now = utcnow()
        with self.transaction() as db:
            for username in dict.fromkeys(name.casefold().strip().lstrip("@") for name in usernames):
                if not username:
                    continue
                cursor = db.execute(
                    """
                    INSERT OR IGNORE INTO auto_candidates(
                        niche_key,instagram_username,source,search_query,discovered_at
                    ) VALUES(?,?,?,?,?)
                    """,
                    (key, username, source, query, now),
                )
                added += cursor.rowcount
        return added

    def record_verified_candidate(
        self,
        key: str,
        username: str,
        query: str,
        status: str,
        followers: int,
        full_name: str,
    ) -> None:
        """Persist a root seed already verified during global discovery."""
        clean = username.casefold().strip().lstrip("@")
        if not clean:
            return
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO auto_candidates(
                    niche_key,instagram_username,source,search_query,status,
                    followers_count,full_name,is_russian,discovered_at,checked_at
                ) VALUES(?,?, 'search_seed',?,?,?,?,1,?,?)
                ON CONFLICT(niche_key,instagram_username) DO UPDATE SET
                    status=excluded.status,
                    followers_count=excluded.followers_count,
                    full_name=excluded.full_name,
                    is_russian=1,
                    error=NULL,
                    checked_at=excluded.checked_at
                """,
                (key, clean, query, status, followers, full_name, now, now),
            )

    def pending_candidates(self, key: str) -> int:
        with self.connect() as db:
            row = db.execute(
                "SELECT COUNT(*) total FROM auto_candidates WHERE niche_key=? AND status='pending'",
                (key,),
            ).fetchone()
        return int(row["total"])

    def donor_candidates(self, key: str, min_followers: int, limit: int) -> list[str]:
        """Return verified niche profiles that have not been used as donors yet."""
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT instagram_username
                FROM auto_candidates
                WHERE niche_key=? AND donor_attempted=0
                  AND followers_count>=?
                  AND is_russian=1
                  AND status IN ('accepted','no_telegram','duplicate')
                ORDER BY id ASC
                LIMIT ?
                """,
                (key, min_followers, limit),
            ).fetchall()
        return [str(row["instagram_username"]) for row in rows]

    def attempted_donors(self, key: str) -> set[str]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT instagram_username FROM auto_candidates "
                "WHERE niche_key=? AND donor_attempted=1",
                (key,),
            ).fetchall()
        return {str(row["instagram_username"]).casefold() for row in rows}

    def record_donor_attempt(self, key: str, username: str, query: str) -> None:
        """Persist donor use so later cycles expand to different profiles."""
        clean = username.casefold().strip().lstrip("@")
        if not clean:
            return
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                """
                INSERT OR IGNORE INTO auto_candidates(
                    niche_key,instagram_username,source,search_query,status,
                    donor_attempted,discovered_at
                ) VALUES(?,?, 'donor',?, 'pending',1,?)
                """,
                (key, clean, query, now),
            )
            db.execute(
                "UPDATE auto_candidates SET donor_attempted=1,error=NULL "
                "WHERE niche_key=? AND instagram_username=?",
                (key, clean),
            )

    def record_donor_failure(
        self, key: str, username: str, query: str, reason: str, max_failures: int = 3,
    ) -> int:
        """Retry an incomplete graph without trapping the worker forever."""
        clean = username.casefold().strip().lstrip("@")
        if not clean:
            return 0
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                """
                INSERT OR IGNORE INTO auto_candidates(
                    niche_key,instagram_username,source,search_query,status,
                    donor_failures,discovered_at
                ) VALUES(?,?, 'donor',?, 'pending',0,?)
                """,
                (key, clean, query, now),
            )
            db.execute(
                """
                UPDATE auto_candidates
                SET donor_failures=donor_failures+1,error=?
                WHERE niche_key=? AND instagram_username=?
                """,
                (reason[:500], key, clean),
            )
            row = db.execute(
                "SELECT donor_failures FROM auto_candidates "
                "WHERE niche_key=? AND instagram_username=?",
                (key, clean),
            ).fetchone()
            failures = int(row["donor_failures"] if row else 0)
            if failures >= max(1, max_failures):
                db.execute(
                    "UPDATE auto_candidates SET donor_attempted=1,rejection_reason=? "
                    "WHERE niche_key=? AND instagram_username=?",
                    (f"Не удалось полностью открыть связи после {failures} попыток", key, clean),
                )
            return failures

    def record_seed_rejection(
        self, key: str, username: str, query: str, reason: str,
    ) -> None:
        """Remember an invalid global-search seed so it is not opened forever."""
        clean = username.casefold().strip().lstrip("@")
        if not clean:
            return
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                """
                INSERT OR IGNORE INTO auto_candidates(
                    niche_key,instagram_username,source,search_query,status,
                    rejection_reason,donor_attempted,discovered_at,checked_at
                ) VALUES(?,?, 'search_seed',?, 'seed_rejected',?,1,?,?)
                """,
                (key, clean, query, reason[:500], now, now),
            )
            db.execute(
                """
                UPDATE auto_candidates
                SET donor_attempted=1,
                    rejection_reason=COALESCE(rejection_reason,?)
                WHERE niche_key=? AND instagram_username=?
                """,
                (reason[:500], key, clean),
            )

    def claim_candidates(self, key: str, limit: int) -> list[sqlite3.Row]:
        with self.transaction() as db:
            rows = list(
                db.execute(
                    "SELECT * FROM auto_candidates WHERE niche_key=? AND status='pending' "
                    "ORDER BY id LIMIT ?",
                    (key, limit),
                )
            )
            if rows:
                placeholders = ",".join("?" for _ in rows)
                db.execute(
                    f"UPDATE auto_candidates SET status='checking',attempts=attempts+1 "
                    f"WHERE id IN ({placeholders})",
                    tuple(int(row["id"]) for row in rows),
                )
            return rows

    def finish_candidate(
        self,
        candidate_id: int,
        status: str,
        followers: int | None = None,
        full_name: str | None = None,
        reason: str | None = None,
        error: str | None = None,
        is_russian: bool | None = None,
    ) -> None:
        with self.transaction() as db:
            db.execute(
                """
                UPDATE auto_candidates
                SET status=?,followers_count=?,full_name=?,rejection_reason=?,error=?,
                    is_russian=COALESCE(?,is_russian),checked_at=?
                WHERE id=?
                """,
                (
                    status, followers, full_name, reason, error,
                    None if is_russian is None else int(is_russian), utcnow(), candidate_id,
                ),
            )

    def retry_candidate(self, candidate_id: int, error: str) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE auto_candidates SET status='pending',error=? WHERE id=?",
                (error[:500], candidate_id),
            )

    def release_claimed_candidates(self, key: str, error: str) -> int:
        """Return an interrupted batch to the durable queue."""
        with self.transaction() as db:
            cursor = db.execute(
                "UPDATE auto_candidates SET status='pending',error=? "
                "WHERE niche_key=? AND status IN ('checking','processing')",
                (error[:500], key),
            )
            return cursor.rowcount

    def enqueue_manual(self, target: str, keyword: str, chat_id: int) -> tuple[int, int]:
        with self.transaction() as db:
            cursor = db.execute(
                "INSERT INTO parse_queue(target,keyword,chat_id,status,created_at) VALUES(?,?,?,'queued',?)",
                (target, keyword, chat_id, utcnow()),
            )
            queue_id = int(cursor.lastrowid)
            ahead = db.execute(
                "SELECT COUNT(*) total FROM parse_queue WHERE status IN ('queued','running') AND id<?",
                (queue_id,),
            ).fetchone()["total"]
            return queue_id, int(ahead)

    def claim_manual(self) -> sqlite3.Row | None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM parse_queue WHERE status='queued' ORDER BY id LIMIT 1"
            ).fetchone()
            if row:
                db.execute(
                    "UPDATE parse_queue SET status='running',started_at=?,error=NULL WHERE id=?",
                    (utcnow(), int(row["id"])),
                )
            return row

    def finish_manual(self, queue_id: int, status: str, error: str | None = None) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE parse_queue SET status=?,finished_at=?,error=? WHERE id=?",
                (status, utcnow(), error, queue_id),
            )

    def active_manual(self) -> list[sqlite3.Row]:
        with self.connect() as db:
            return list(
                db.execute(
                    "SELECT * FROM parse_queue WHERE status IN ('queued','running') ORDER BY id"
                )
            )

    def lead_exists(self, username: str) -> bool:
        with self.connect() as db:
            row = db.execute(
                "SELECT 1 FROM leads WHERE instagram_username=? COLLATE NOCASE",
                (username,),
            ).fetchone()
        return row is not None

    def queue_remote_lead(self, niche: str, lead: Lead) -> None:
        payload = json.dumps(
            {
                "username": lead.username,
                "full_name": lead.full_name,
                "instagram_url": lead.instagram_url,
                "followers": lead.followers,
                "telegram_urls": list(lead.telegram_urls),
            },
            ensure_ascii=False,
        )
        with self.transaction() as db:
            db.execute(
                """
                INSERT INTO remote_lead_outbox(
                    instagram_username,niche,payload,created_at
                ) VALUES(?,?,?,?)
                ON CONFLICT(instagram_username) DO UPDATE SET
                    niche=excluded.niche,payload=excluded.payload
                """,
                (lead.username, niche, payload, utcnow()),
            )

    def pending_remote_leads(self, limit: int = 100) -> list[tuple[int, str, Lead]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT id,niche,payload FROM remote_lead_outbox ORDER BY id LIMIT ?",
                (max(1, limit),),
            ).fetchall()
        pending: list[tuple[int, str, Lead]] = []
        for row in rows:
            raw = json.loads(str(row["payload"]))
            pending.append((
                int(row["id"]),
                str(row["niche"]),
                Lead(
                    username=str(raw["username"]),
                    full_name=str(raw.get("full_name", "")),
                    instagram_url=str(raw["instagram_url"]),
                    followers=(int(raw["followers"]) if raw.get("followers") is not None else None),
                    telegram_urls=tuple(str(item) for item in raw.get("telegram_urls", [])),
                ),
            ))
        return pending

    def mark_remote_lead_sent(self, outbox_id: int) -> None:
        with self.transaction() as db:
            db.execute("DELETE FROM remote_lead_outbox WHERE id=?", (outbox_id,))

    def counts(self) -> dict[str, int]:
        with self.connect() as db:
            leads = db.execute(
                "SELECT COUNT(*) total,SUM(is_hidden) hidden FROM leads"
            ).fetchone()
            categories = db.execute(
                "SELECT COUNT(*) total FROM sources WHERE source_type='auto' AND is_hidden=0"
            ).fetchone()
        return {
            "leads": int(leads["total"] or 0),
            "hidden": int(leads["hidden"] or 0),
            "categories": int(categories["total"] or 0),
        }
