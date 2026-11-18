#!/usr/bin/env python3
"""Generate a_bogus golden vectors from the reference Python implementation.

Dev-only helper: requires the reference repository checked out locally and the
`gmssl`-compatible SM3 shim on PYTHONPATH (or the real gmssl package).

Usage:
  PYTHONPATH=../.tmp-py python3 scripts/gen-abogus-vectors.py \
      --abogus ../astrbot_plugin_link_resolver/core/douyin/abogus.py \
      --out test/fixtures/abogus-vectors.json
"""

import argparse
import importlib.util
import json
from pathlib import Path

FIXED_PREFIX = "\x11\x22\x33\x44\x55\x66\x77\x88\x99\xaa\xbb\xcc"


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("ref_abogus", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--abogus", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    module = load_module(Path(args.abogus).resolve())
    module.StringProcessor.generate_random_bytes = staticmethod(lambda length=3: FIXED_PREFIX[: length * 4])

    cases = [
        {
            "name": "get-basic",
            "params": "device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=7708744445503573289",
            "body": "",
            "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
            "fp": "1920|1080|1950|1170|0|30|0|0|1920|1080|1920|1080|1920|1080|24|24|Win32",
            "now": 1794926000000,
        },
        {
            "name": "get-second",
            "params": "device_platform=webapp&aid=6383&aweme_id=7345492945006595379&msToken=abc",
            "body": "",
            "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            "fp": "1280|720|1312|800|0|0|0|0|1280|720|1366|768|1280|720|24|24|Win32",
            "now": 1794926123456,
        },
        {
            "name": "post-body",
            "params": "device_platform=webapp&aid=6383&aweme_id=7708744445503573289",
            "body": "aweme_type=0&item_id=7708744445503573289&play_delta=1",
            "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
            "fp": "1600|900|1632|990|0|30|0|0|1600|900|1920|1040|1600|900|24|24|Win32",
            "now": 1794926999999,
        },
    ]

    out = []
    for case in cases:
        module.time.time = lambda now=case["now"]: now / 1000.0
        abogus = module.ABogus(fp=case["fp"], user_agent=case["ua"])
        params_with, signature, _ua, _body = abogus.generate_abogus(case["params"], case["body"])
        out.append({**case, "a_bogus": signature, "params_with": params_with})

    Path(args.out).write_text(json.dumps({"fixedPrefix": FIXED_PREFIX, "cases": out}, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {len(out)} vectors -> {args.out}")


if __name__ == "__main__":
    main()
