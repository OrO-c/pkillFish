import unittest
from datetime import datetime
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scrape_aicu import normalize_mid, normalize_reply, parse_time  # noqa: E402


class ScrapeHelpersTest(unittest.TestCase):
    def test_mid(self):
        self.assertEqual(normalize_mid("123456"), "123456")
        self.assertEqual(normalize_mid("0123"), "")
        self.assertEqual(normalize_mid("abc"), "")

    def test_parse_unix_time(self):
        parsed = parse_time(1792046055)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.year, 2026)
        self.assertEqual(parsed.month, 10)

    def test_normalize_reply(self):
        row = normalize_reply(
            {
                "rpid": "123",
                "message": "这是一条测试评论",
                "time": 1792046055,
                "parent": {},
                "dyn": {"oid": "999", "type": 1},
            },
            "123456",
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["uid"], "123456")
        self.assertEqual(row["rpid"], "123")
        self.assertEqual(row["oid"], "999")
        self.assertEqual(row["type"], "1")
        self.assertIn("2026-10", row["ctime"])


if __name__ == "__main__":
    unittest.main()
