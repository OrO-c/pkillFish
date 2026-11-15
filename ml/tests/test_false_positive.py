import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collect_false_positives import parse_meta, parse_text  # noqa: E402


BODY = """<!-- pkillfish:ml-false-positive
uid: 123456
mid: 123456
rpid: 987654
link: https://www.bilibili.com/video/BV1xx/#reply987654
model: 0.2.0
score: 0.99
-->

### 机器学习误判反馈

### 评论原文

~~~text
这是正常的评论原文。
~~~
"""


class FalsePositiveParserTest(unittest.TestCase):
    def test_meta(self):
        meta = parse_meta(BODY)
        self.assertEqual(meta["uid"], "123456")
        self.assertEqual(meta["rpid"], "987654")
        self.assertEqual(meta["model"], "0.2.0")

    def test_text(self):
        self.assertEqual(parse_text(BODY), "这是正常的评论原文。")


if __name__ == "__main__":
    unittest.main()
