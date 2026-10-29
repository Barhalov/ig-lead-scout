"""Loopback-only adapter: IG Lead Scout -> existing laptop lead database."""
import hmac
import json
import logging
import re
import sqlite3
import sys
import time
import uuid
from logging.handlers import RotatingFileHandler
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'bridge-config.json').read_text(encoding='utf-8'))
ROOT = (HERE / CONFIG['root']).resolve()
sys.path.insert(0, str(ROOT))
from v2.database import Database
from v2.models import Lead
from v2.links import profile_telegram_links
from v2.niches import looks_russian, excluded_geography

DB_PATH = ROOT / 'data' / 'bot.sqlite3'
TOKEN = CONFIG['token']
logging.basicConfig(filename=str(HERE / 'bridge.log'), level=logging.INFO,
                    format='%(asctime)s %(message)s', encoding='utf-8')
events = logging.getLogger('parser_events')
events.propagate = False
events.setLevel(logging.INFO)
event_handler = RotatingFileHandler(HERE / 'events.jsonl', maxBytes=10_000_000, backupCount=4, encoding='utf-8')
event_handler.setFormatter(logging.Formatter('%(message)s'))
events.addHandler(event_handler)

def event(stage, **fields):
    events.info(json.dumps({'at': time.time(), 'stage': stage, **fields}, ensure_ascii=False))

class CheckQueue:
    def __init__(self, path):
        self.path = path
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.execute('CREATE TABLE IF NOT EXISTS checks (username TEXT PRIMARY KEY, until REAL NOT NULL, record TEXT)')
            columns = {r[1] for r in conn.execute('PRAGMA table_info(checks)')}
            for column in ('token', 'worker'):
                if column not in columns:
                    conn.execute('ALTER TABLE checks ADD COLUMN ' + column + ' TEXT')
            conn.execute('CREATE TABLE IF NOT EXISTS donors (username TEXT, kind TEXT, worker TEXT, until REAL, PRIMARY KEY(username,kind))')

    def claim(self, username, worker='legacy'):
        now = time.time()
        with closing(sqlite3.connect(self.path, timeout=5)) as conn, conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT until, record FROM checks WHERE username=?', (username,)).fetchone()
            if row and row[0] > now:
                return {'ok': True, 'claimed': False, 'reason': 'cached' if row[1] else 'busy',
                        'record': json.loads(row[1]) if row[1] else None}
            token = uuid.uuid4().hex
            conn.execute('INSERT OR REPLACE INTO checks (username,until,record,token,worker) VALUES (?, ?, NULL, ?, ?)', (username, now + 90, token, worker))
        event('check_claimed', username=username, worker=worker, token=token)
        return {'ok': True, 'claimed': True, 'token': token}

    def complete(self, record):
        username = str(record.get('username', '')).lower()
        followers = record.get('followers')
        readable = isinstance(followers, (int, float)) and not isinstance(followers, bool)
        # Failed extraction is retryable; real negative results are shared for a day.
        ttl = 86400 if readable or record.get('isPrivate') else 60
        with closing(sqlite3.connect(self.path, timeout=5)) as conn, conn:
            conn.execute('BEGIN IMMEDIATE')
            current = conn.execute('SELECT token,worker FROM checks WHERE username=?', (username,)).fetchone()
            token = record.get('laptopClaimToken')
            if current and current[1] != 'legacy' and token != current[0]:
                event('stale_result_ignored', username=username, worker=record.get('laptopWorker'))
                return False
            conn.execute('INSERT OR REPLACE INTO checks (username,until,record,token,worker) VALUES (?, ?, ?, ?, ?)',
                         (username, time.time() + ttl, json.dumps(record, ensure_ascii=False), token,
                          record.get('laptopWorker', 'legacy')))
        return True

    def donor(self, username, kind, worker):
        if username.lower() in {str(name).lower() for name in CONFIG.get('excluded_donors', [])}:
            event('donor_excluded', username=username, worker=worker, reason='private_profile')
            return False
        now = time.time()
        with closing(sqlite3.connect(self.path, timeout=5)) as conn, conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT worker,until FROM donors WHERE username=? AND kind=?', (username, kind)).fetchone()
            if row and row[1] > now and row[0] != worker:
                return False
            # A worker owns only its current donor; refreshes renew the same lease.
            conn.execute('DELETE FROM donors WHERE worker=? AND (username<>? OR kind<>?)', (worker, username, kind))
            conn.execute('INSERT OR REPLACE INTO donors VALUES (?,?,?,?)', (username, kind, worker, now + 120))
        return True

def qualify(record):
    username = str(record.get('username', '')).strip().lower()
    if not re.fullmatch(r'[a-z0-9_.]{1,30}', username):
        return None, 'invalid_username'
    if record.get('isPrivate'):
        return None, 'private_profile'
    followers = record.get('followers')
    if isinstance(followers, bool) or not isinstance(followers, (int, float)):
        return None, 'followers_unreadable'
    if followers < 3000:
        return None, 'followers_below_3000'
    if record.get('tgSpeculative') or record.get('tgFromHandle'):
        return None, 'speculative_telegram'
    bio = str(record.get('bio', ''))
    name = str(record.get('fullName', ''))
    text = name + '\n' + bio
    if not looks_russian(text) or excluded_geography(text + '\n' + username):
        return None, 'language_or_geography'
    # Only actual profile hrefs. Never trust a guessed handle or rendered link label.
    outgoing = record.get('laptopProfileUrls', [])
    if not isinstance(outgoing, list):
        return None, 'invalid_links'
    links = profile_telegram_links(bio, outgoing)
    if not links:
        return None, 'no_direct_telegram'
    return Lead(username=username, full_name=name,
                instagram_url=f'https://www.instagram.com/{username}/',
                followers=int(followers), telegram_urls=tuple(links)), None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {'ok': False})
        if self.path == '/health':
            return self.reply(200, {'ok': True})
        if self.path == '/bootstrap':
            with closing(sqlite3.connect(f'file:{DB_PATH.as_posix()}?mode=ro', uri=True)) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute('''SELECT l.* FROM leads l JOIN source_leads sl
                    ON sl.lead_id=l.id WHERE sl.source_id=72 ORDER BY l.id DESC''').fetchall()
            profiles = []
            for row in rows:
                urls = json.loads(row['telegram_urls'] or '[]')
                profiles.append({'username': row['instagram_username'],
                    'fullName': row['full_name'] or '', 'followers': row['followers_count'],
                    'telegrams': urls, 'telegram': urls[0] if urls else None,
                    'laptopHistorical': True, 'checkedAt': 1})
            return self.reply(200, {'profiles': profiles})
        return self.reply(404, {'ok': False})

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {'ok': False})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 65536:
                return self.reply(413, {'ok': False})
            data = json.loads(self.rfile.read(size))
            if self.path == '/event' and isinstance(data, dict):
                allowed = ('worker','username','kind','sid','hb','prog','checked','pauseWhy','pauseTill','action','tabId','outbox','error')
                event(str(data.get('stage', 'status'))[:60], **{k: data[k] for k in allowed if k in data})
                return self.reply(200, {'ok': True})
            if self.path == '/donor' and isinstance(data, dict):
                username = str(data.get('username', '')).lower()
                kind = data.get('kind')
                worker = str(data.get('worker', ''))[:100]
                if not re.fullmatch(r'[a-z0-9_.]{1,30}', username) or kind not in ('following','followers') or not worker:
                    return self.reply(400, {'ok': False})
                claimed = check_queue.donor(username, kind, worker)
                event('donor_claim' if claimed else 'donor_busy', username=username, kind=kind, worker=worker)
                return self.reply(200, {'ok': True, 'claimed': claimed})
            if self.path == '/claim' and isinstance(data, dict):
                username = str(data.get('username', '')).strip().lower()
                if not re.fullmatch(r'[a-z0-9_.]{1,30}', username):
                    return self.reply(400, {'ok': False})
                result = check_queue.claim(username, str(data.get('worker','legacy'))[:100])
                if not result['claimed']:
                    event('check_skipped', username=username, worker=data.get('worker'), reason=result['reason'])
                return self.reply(200, result)
            if self.path != '/profile' or not isinstance(data, dict):
                return self.reply(400, {'ok': False})
            lead, reason = qualify(data)
            if reason != 'invalid_username':
                if not check_queue.complete(data):
                    return self.reply(200, {'ok': True, 'created': False, 'reason': 'stale_result'})
            event('profile_result', username=data.get('username'), worker=data.get('laptopWorker'),
                  token=data.get('laptopClaimToken'), followers=data.get('followers'), reason=reason or 'qualified')
            if reason:
                logging.info('Rejected @%s: %s', data.get('username'), reason)
                return self.reply(200, {'ok': True, 'created': False, 'reason': reason})
            # Historical hidden/outreach records must remain untouched.
            if database.lead_exists(lead.username):
                event('lead_known', username=lead.username, worker=data.get('laptopWorker'))
                return self.reply(200, {'ok': True, 'created': False, 'reason': 'already_known'})
            created, lead_id = database.add_lead(72, 'фитнес тренер', lead)
            event('lead_saved', username=lead.username, worker=data.get('laptopWorker'), created=created, lead_id=lead_id)
            logging.info('Profile @%s followers=%s created=%s lead_id=%s',
                         lead.username, lead.followers, created, lead_id)
            self.reply(200, {'ok': True, 'created': created, 'lead_id': lead_id})
        except Exception:
            logging.exception('Profile import failed')
            self.reply(500, {'ok': False, 'error': 'import_failed'})

if __name__ == '__main__':
    database = Database(DB_PATH)
    check_queue = CheckQueue(HERE / 'check-queue.sqlite3')
    logging.info('Bridge starting on 127.0.0.1:8766')
    HTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
