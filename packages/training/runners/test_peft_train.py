"""Unit tests for peft_train's dataset handling (no torch needed).

    python3 -m unittest packages/training/runners/test_peft_train.py
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import peft_train as pt  # noqa: E402


class ChatMLTok:
    """A character-level tokenizer with a ChatML template (Qwen/SmolLM style)."""

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [ord(c) for c in text]}

    def apply_chat_template(self, msgs, tokenize=False, add_generation_prompt=False):
        out = "".join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in msgs)
        return out + ("<|im_start|>assistant\n" if add_generation_prompt else "")


class OddTok(ChatMLTok):
    """A template whose prefixes do not nest (it summarizes the turn count first)."""

    def apply_chat_template(self, msgs, tokenize=False, add_generation_prompt=False):
        return f"[{len(msgs)}]" + super().apply_chat_template(msgs, tokenize, add_generation_prompt)


def learned(ids, labels):
    return "".join(chr(i) for i, l in zip(ids, labels) if l != pt.IGNORE)


CHAT = {"messages": [
    {"role": "user", "content": "hi"},
    {"role": "assistant", "content": "hello"},
    {"role": "user", "content": "price?"},
    {"role": "assistant", "content": "charge for value"},
]}


class DatasetTests(unittest.TestCase):
    def test_parse_record_shapes(self):
        self.assertEqual(pt.parse_record({"text": "body", "title": "T"}), {"title": "T", "text": "body"})
        self.assertEqual(pt.parse_record(CHAT)["messages"][3]["content"], "charge for value")
        self.assertIsNone(pt.parse_record({"messages": [{"role": "user", "content": "only a question"}]}))
        self.assertIsNone(pt.parse_record({"foo": 1}))
        with self.assertRaises(ValueError):
            pt.parse_record({"messages": [{"role": "tool", "content": "x"}, {"role": "assistant", "content": "y"}]})
        with self.assertRaises(ValueError):
            pt.parse_record({"messages": [{"role": "assistant", "content": 3}]})

    def test_load_dataset_mixes_text_and_conversations(self):
        with tempfile.TemporaryDirectory() as d:
            lines = [json.dumps({"title": "A", "text": "x"}), "", json.dumps(CHAT)]
            Path(d, "c.jsonl").write_text("\n".join(lines) + "\n")
            docs, digest = pt.load_dataset({"url": "c.jsonl"}, Path(d))
            self.assertEqual(len(docs), 2)
            self.assertIn("messages", docs[1])
            self.assertEqual(len(digest), 64)
            with self.assertRaises(ValueError):
                pt.load_dataset({"url": "c.jsonl", "sha256": "0" * 64}, Path(d))
            with self.assertRaises(ValueError):
                pt.load_dataset({"url": "https://evil/x"}, Path(d))

    def test_every_turn_is_kept_and_only_assistant_turns_learn(self):
        ids, labels = pt.encode(ChatMLTok(), CHAT, "be brief")
        text = "".join(chr(i) for i in ids)
        # The whole conversation, both exchanges, with the job's system prompt added.
        self.assertEqual(text, ChatMLTok().apply_chat_template([{"role": "system", "content": "be brief"}, *CHAT["messages"]]))
        self.assertEqual(len(ids), len(labels))
        self.assertEqual(learned(ids, labels), "hello<|im_end|>\ncharge for value<|im_end|>\n")

    def test_a_conversation_keeps_its_own_system_prompt(self):
        doc = {"messages": [{"role": "system", "content": "mine"}, *CHAT["messages"]]}
        text = "".join(chr(i) for i in pt.encode(ChatMLTok(), doc, "job default")[0])
        self.assertIn("mine", text)
        self.assertNotIn("job default", text)

    def test_text_docs_train_as_before(self):
        ids, labels = pt.encode(ChatMLTok(), {"title": "Pricing", "text": "value"}, "sys")
        self.assertEqual(ids, labels)
        self.assertIn("Brief me on: Pricing", "".join(chr(i) for i in ids))

    def test_a_template_that_does_not_nest_learns_everything(self):
        ids, labels = pt.encode(OddTok(), CHAT, "sys")
        self.assertEqual(ids, labels)
        self.assertTrue("".join(chr(i) for i in ids).startswith("[5]"))

    def test_pack_drops_blocks_with_nothing_to_learn(self):
        enc = [([1, 2, 3, 4], [pt.IGNORE] * 4), ([5, 6, 7, 8], [5, 6, 7, 8])]
        blocks = pt.pack_ids(enc, 4)
        self.assertEqual(blocks, [([5, 6, 7, 8], [5, 6, 7, 8])])
        # Blocks straddle docs; a partial tail is dropped.
        self.assertEqual(pt.pack_ids(enc, 3), [([4, 5, 6], [pt.IGNORE, 5, 6])])

    def test_formats_are_advertised(self):
        self.assertEqual(pt.DATASET_FORMATS, ("text", "messages"))


if __name__ == "__main__":
    unittest.main()
