# -*- coding: utf-8 -*-
"""从本地测试图生成网页示例。需要 Pillow，服务器运行本身不需要。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import prompt_meta  # noqa: E402

SOURCE = Path(r"D:\AI\.AI生图\带工作流的图片")
OUT = ROOT / "public" / "samples"
PICKS = [
    ("2e9391c3afe9e12fbe338a8b037247f11522948414.png", "深海观测站"),
    ("ComfyUI_temp_aihlf_00010_.png", "巨构与人影"),
    ("ComfyUI_temp_amcqd_00007_.png", "明日香海报"),
    ("ComfyUI_temp_bbytj_00023_.png", "凋零的百合"),
    ("ComfyUI_temp_jttbz_00001_.png", "砖墙拼贴"),
    ("ComfyUI_temp_jttbz_00002_.png", "勃艮第典礼"),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    items = []
    for index, (name, title) in enumerate(PICKS, start=1):
        path = SOURCE / name
        if not path.exists():
            raise SystemExit(f"找不到测试图：{path}")
        parsed = prompt_meta.extract_bytes(path.read_bytes(), name)
        if len(parsed.get("positive") or "") < 40:
            raise SystemExit(f"没有读出提示词：{name} {parsed.get('warning')}")
        image = Image.open(path).convert("RGB")
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        filename = f"{index:02d}.jpg"
        image.save(OUT / filename, "JPEG", quality=84, optimize=True, progressive=True)
        items.append(
            {
                "id": f"sample-{index:02d}",
                "name": title,
                "image": filename,
                "positive": parsed["positive"],
                "negative": parsed["negative"],
                "source": parsed["source"],
                "meta": parsed["meta"],
                "warning": "",
            }
        )
        print(f"{filename}  {len(parsed['positive'])} chars  {parsed['source']}")
    (OUT / "manifest.json").write_text(
        json.dumps({"items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("wrote", OUT / "manifest.json")


if __name__ == "__main__":
    main()
