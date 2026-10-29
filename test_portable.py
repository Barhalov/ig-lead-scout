"""Fresh-checkout setup and real HTTP-to-SQLite round-trip, using only fake data."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

import bridge
import setup_local


class PortableTests(unittest.TestCase):
    def test_setup_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'ig-lead-scout').mkdir()
            with patch.object(setup_local, 'ROOT', root):
                setup_local.main()
                first = (root / 'bridge-config.json').read_text()
                setup_local.main()
                self.assertEqual(first, (root / 'bridge-config.json').read_text())
            db = bridge.Database(root / 'data' / 'bot.sqlite3')
            with db.connect() as connection:
                self.assertEqual(connection.execute('SELECT count(*) FROM leads').fetchone()[0], 0)
                self.assertEqual(connection.execute('SELECT id FROM sources').fetchone()[0], 72)

    def test_new_lead_roundtrip_and_dedup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'ig-lead-scout').mkdir()
            with patch.object(setup_local, 'ROOT', root):
                setup_local.main()
            db_path = root / 'data' / 'bot.sqlite3'
            database = bridge.Database(db_path)
            queue = bridge.CheckQueue(root / 'queue.sqlite3')
            with patch.object(bridge, 'database', database, create=True), \
                 patch.object(bridge, 'check_queue', queue, create=True), \
                 patch.object(bridge, 'DB_PATH', db_path):
                server = bridge.HTTPServer(('127.0.0.1', 0), bridge.Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()

                def call(path, payload=None):
                    request = Request(
                        'http://127.0.0.1:' + str(server.server_port) + path,
                        data=json.dumps(payload).encode() if payload is not None else None,
                        headers={'Authorization': 'Bearer ' + bridge.TOKEN,
                                 'Content-Type': 'application/json'})
                    with urlopen(request, timeout=5) as response:
                        return json.load(response)

                try:
                    claim = call('/claim', {'username': 'test_fitness_lead', 'worker': 'test-worker'})
                    profile = dict(username='test_fitness_lead', fullName='Тренер Иван',
                                   bio='Фитнес тренер', followers=4000,
                                   laptopProfileUrls=['https://t.me/testfitnesschannel'],
                                   laptopClaimToken=claim['token'], laptopWorker='test-worker')
                    self.assertTrue(call('/profile', profile)['created'])
                    self.assertEqual(call('/profile', profile)['reason'], 'already_known')
                    self.assertEqual(len(call('/bootstrap')['profiles']), 1)
                    with database.connect() as connection:
                        self.assertEqual(connection.execute('SELECT count(*) FROM leads').fetchone()[0], 1)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
