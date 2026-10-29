import json
import tempfile
import unittest
from pathlib import Path
import bridge

class Tests(unittest.TestCase):
    def profile(self, **changes):
        data = dict(username='test_trainer', fullName='Тренер Иван', bio='Онлайн тренер',
                    followers=3000, laptopProfileUrls=['https://t.me/test_person'])
        data.update(changes)
        return data
    def test_valid(self):
        lead, reason = bridge.qualify(self.profile())
        self.assertIsNone(reason)
        self.assertEqual(lead.telegram_urls, ('https://t.me/test_person',))
    def test_threshold(self):
        for count in (1999, 2999, None, True):
            self.assertIsNone(bridge.qualify(self.profile(followers=count))[0])
        for count in (3000, 3999, 4000):
            self.assertIsNotNone(bridge.qualify(self.profile(followers=count))[0])
        self.assertEqual(bridge.qualify(self.profile(followers=None))[1], 'followers_unreadable')
        self.assertEqual(bridge.qualify(self.profile(followers=2999))[1], 'followers_below_3000')

    def test_private(self):
        self.assertEqual(bridge.qualify(self.profile(isPrivate=True))[1], 'private_profile')

    def test_late_owner_cannot_overwrite(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as folder:
            queue = bridge.CheckQueue(Path(folder) / 'queue.sqlite3')
            old = queue.claim('test_trainer', 'worker-a')
            with sqlite3.connect(queue.path) as conn:
                conn.execute('UPDATE checks SET until=0')
            conn.close()
            new = queue.claim('test_trainer', 'worker-b')
            self.assertTrue(queue.complete(self.profile(laptopWorker='worker-b', laptopClaimToken=new['token'])))
            self.assertFalse(queue.complete(self.profile(followers=None, laptopWorker='worker-a', laptopClaimToken=old['token'])))
            self.assertEqual(queue.claim('test_trainer')['record']['followers'], 3000)

    def test_donor_reservation(self):
        with tempfile.TemporaryDirectory() as folder:
            queue = bridge.CheckQueue(Path(folder) / 'queue.sqlite3')
            self.assertTrue(queue.donor('donor_a','following','worker-a'))
            self.assertFalse(queue.donor('donor_a','following','worker-b'))
            self.assertTrue(queue.donor('donor_a','following','worker-a'))
            self.assertTrue(queue.donor('donor_b','following','worker-a'))
            self.assertTrue(queue.donor('donor_a','following','worker-b'))

    def test_shared_claim_and_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            queue = bridge.CheckQueue(Path(folder) / 'queue.sqlite3')
            self.assertTrue(queue.claim('test_trainer')['claimed'])
            self.assertEqual(queue.claim('test_trainer')['reason'], 'busy')
            queue.complete(self.profile())
            shared = bridge.CheckQueue(queue.path).claim('test_trainer')
            self.assertFalse(shared['claimed'])
            self.assertEqual(shared['record']['followers'], 3000)

    def test_expired_claim_is_retryable(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as folder:
            queue = bridge.CheckQueue(Path(folder) / 'queue.sqlite3')
            queue.claim('test_trainer')
            with sqlite3.connect(queue.path) as conn:
                conn.execute('UPDATE checks SET until=0')
            conn.close()
            self.assertTrue(queue.claim('test_trainer')['claimed'])
    def test_guessed(self):
        self.assertIsNone(bridge.qualify(self.profile(tgFromHandle=True))[0])
        self.assertIsNone(bridge.qualify(self.profile(tgSpeculative=True))[0])
    def test_no_tg(self):
        self.assertIsNone(bridge.qualify(self.profile(laptopProfileUrls=[]))[0])
    def test_stale_label(self):
        lead, _ = bridge.qualify(self.profile(bio='Телеграм https://t.me/old_person'))
        self.assertEqual(lead.telegram_urls, ('https://t.me/test_person',))
    def test_redirect_and_invite(self):
        lead, _ = bridge.qualify(self.profile(laptopProfileUrls=[
            'https://l.instagram.com/?u=https%3A%2F%2Ft.me%2F%2Babcdefg']))
        self.assertEqual(lead.telegram_urls, ('https://t.me/+abcdefg',))
    def test_foreign(self):
        self.assertIsNone(bridge.qualify(self.profile(bio='Тренер Київ 🇺🇦'))[0])
    def test_database_dedup_hidden(self):
        with tempfile.TemporaryDirectory() as folder:
            db = bridge.Database(Path(folder) / 'test.sqlite3')
            source = db.ensure_auto_source('фитнес тренер')
            lead, _ = bridge.qualify(self.profile())
            self.assertTrue(db.add_lead(source, 'фитнес тренер', lead)[0])
            self.assertFalse(db.add_lead(source, 'фитнес тренер', lead)[0])

if __name__ == '__main__': unittest.main()
