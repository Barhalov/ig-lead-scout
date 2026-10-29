"""Create this checkout's private local configuration and an empty database."""
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path

from v2.database import Database

ROOT = Path(__file__).resolve().parent


def main():
    config_path = ROOT / 'bridge-config.json'
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding='utf-8'))
    else:
        config = {'root': '.', 'token': secrets.token_hex(32), 'excluded_donors': []}
        config_path.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    runtime_root = (ROOT / config['root']).resolve()
    database = Database(runtime_root / 'data' / 'bot.sqlite3')
    now = datetime.now(timezone.utc).isoformat()
    with database.transaction() as connection:
        connection.execute(
            'INSERT OR IGNORE INTO sources(id,instagram_username,created_at,updated_at,display_name) '
            'VALUES(72,?,?,?,?)', ('fitness_local', now, now, 'Фитнес тренер'))
    (ROOT / 'ig-lead-scout' / 'laptop-config.js').write_text(
        "const LAPTOP_API = 'http://127.0.0.1:8766';\nconst LAPTOP_TOKEN = "
        + json.dumps(config['token']) + ';\n', encoding='utf-8')
    print('Local configuration ready. Start: python bridge.py')


if __name__ == '__main__':
    main()
