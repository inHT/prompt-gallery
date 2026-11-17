# -*- coding: utf-8 -*-
"""从 Civitai 下载 LoRA 示例图，并写出 public/lora-samples/manifest.json。

运行需要网络，并用 Pillow 把示例图压成较小的 JPEG。服务器本身不调用这个脚本。
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "public" / "lora-samples"
API = "https://civitai.com/api/v1/models/{}"
WIDTH = 1600
MAX_EDGE = 1280

MODELS = [
    {
        "id": "auroral-nostalgia",
        "modelId": 3001800,
        "name": "AURORAL Nostalgia · 极光旧梦",
        "base": "krea2",
        "url": "https://civitai.com/models/3001800/auroral-nostalgia",
        "summary": """触发词
没有。效果会自动生效——只需描述你的主题和场景即可。

它的作用
光照：暖色定向光，金色边缘光和边缘光晕，柔和的光晕/晕光，更强的光区和阴影分离。
质量：更清晰的渲染，线条和细节保持更细腻，色调渐变更平滑，景深柔和，胶片颗粒感细腻——呈现“完成的插画”效果，而非平面输出。
色彩：冷暖分离，带有怀旧感的胶片级，更丰富但不会过饱和。
推荐浓度
1.0 — 设计强度：清晰的灯光和质量提升，内容保持完整。
1.3 – 1.5 — 明显更强的光晕、光晕和薄膜特性。我们自己的画廊样品是1.5。
0.8及以下——效果会迅速消退。
在Turbo/量化Krea 2检查点上，这种效果比全精度基础略弱一些。
最适合
动漫及半写实动漫插画——单人角色、半身或全身。
写实/摄影肖像和场景——LoRA自然塑造光线，并在写实基础上叠加胶片等级。
利用氛围营造的场景：黄昏、夜晚街道、灯笼光、室内、花园、窗户光。
那些已经能很好地描述主题的提示——让这个LoRA提供光明和收尾。你自己的风格词会稀释它。
诚实的限制
你题目中明确的风格会获胜。如果你要求完全平坦、无光的卡通渲染，LoRA主要会添加颜色和颗粒感，而不是重新绘制光线。
最好用纯内容提示（主题/框架/场景），而不是堆叠式的关键词。
在1.5+的非常柔和或低细节场景中，会用一些微观细节换取氛围;当你想要纹理回来时，可以降到1.0–1.2。
注释
所有图库采样均使用该LoRA生成，运行于Krea 2,10步，CFG 1.0，欧拉/简单，短边1024像素。生成数据是公开的——打开任何示例图片即可阅读其完整的提示和设置。""",
    },
    {
        "id": "anime-in-real",
        "modelId": 1979448,
        "name": "Anime in real",
        "base": "krea2",
        "url": "https://civitai.com/models/1979448/anime-in-real",
        "summary": """这个Lora专注于在现实背景中塑造动漫角色，非常适合以下内容：
Solo
Depth of field
Blurry background
独唱
景深
模糊的背景

有一个触发词，激活Lora非常重要：Ani2rel""",
    },
    {
        "id": "z3zz4-krea-2",
        "modelId": 2771337,
        "name": "Z3ZZ4 Krea 2",
        "base": "krea2",
        "url": "https://civitai.com/models/2771337/z3zz4-krea-2",
        "summary": "无",
    },
    {
        "id": "koukouya-style",
        "modelId": 2844656,
        "name": "画风 こうこうや koukouya style [krea2]",
        "base": "krea2",
        "url": "https://civitai.com/models/2844656/koukouya-style-krea2",
        "summary": """该模型不需要触发词
推荐出图参数：
分辨率：竖屏1280x1856（1536x1536）
lora权重1.0
采样er_sde简单采样次数8""",
    },
    {
        "id": "kok0ya",
        "modelId": 3038150,
        "name": "Kok0ya |椎白的风格",
        "base": "krea2",
        "url": "https://civitai.com/models/3038150/kok0ya-or-shiiros-styles",
        "summary": "权重可从 0.1 到 1",
    },
    {
        "id": "si-wooupp",
        "modelId": 2767709,
        "name": "Krea2 si_(wooupp) Style",
        "base": "krea2",
        "url": "https://civitai.com/models/2767709/krea2-siwooupp-style",
        "summary": """没有触发词
maybe 1000steps比2500steps效果更好，但我懒得再进一步测试XD
例图由1000steps生成""",
    },
    {
        "id": "sushispin",
        "modelId": 2799859,
        "name": "SushiSpin_Style",
        "base": "krea2",
        "url": "https://civitai.com/models/2799859/sushispinstyle",
        "summary": "建议保持重量低于0.8，因为容易过拟合。",
    },
    {
        "id": "houtei9",
        "modelId": 2762845,
        "name": "画风 河底9 Houtei9 style [krea2]",
        "base": "krea2",
        "url": "https://civitai.com/models/2762845/9-houtei9-style-krea2",
        "summary": """这个模型不需要触发词
推荐出图参数
分辨率原生2k
lora权重1
采样er_side simple 采样次数10
可以尝试使用二次采样（高清修复），这能让风格更加浓烈、细节更加清晰。但是同时会产生过量的细节处理，导致整张图看起来很乱，所以我建议lanczos1.5倍放大你的图像，降噪0.2，步数 3步 即可。""",
    },
]


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "prompt-gallery/1.0"})
    last_error = None
    for _attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(1.2)
    raise last_error


def creator_images(model_id: int, limit: int = 5) -> list[dict]:
    """只要这个版本作者自己发的图。作者只发了 2 张就留 2 张，不用其他用户的帖子补。"""
    data = fetch_json(API.format(model_id))
    creator = str((data.get("creator") or {}).get("username") or "").strip()
    versions = data.get("modelVersions") or []
    if not creator or not versions:
        return []
    version_id = versions[0].get("id")
    query = urllib.parse.urlencode(
        {"modelVersionId": version_id, "username": creator, "limit": max(limit, 20)}
    )
    payload = fetch_json("https://civitai.com/api/v1/images?" + query)
    found = []
    seen = set()
    for image in payload.get("items") or []:
        url = image.get("url") or ""
        if image.get("type") not in (None, "image") or not url or url in seen:
            continue
        if image.get("username") != creator or image.get("minor"):
            continue
        seen.add(url)
        found.append(image)
        if len(found) >= limit:
            break
    return found


def sized(url: str, width: int) -> str:
    if "/original=true/" in url:
        return url.replace("/original=true/", f"/width={width}/")
    return re.sub(r"/width=\d+/", f"/width={width}/", url)


def sniff(data: bytes) -> str:
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    return ""


def download(url: str) -> bytes:
    request = urllib.request.Request(sized(url, WIDTH), headers={"User-Agent": "prompt-gallery/1.0"})
    last_error = None
    for _attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            time.sleep(1.2)
    raise last_error


def save_jpeg(data: bytes, path: Path) -> None:
    image = Image.open(BytesIO(data))
    image = image.convert("RGB")
    image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    image.save(path, "JPEG", quality=82, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="下载 LoRA 示例图")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = args.out
    items = []
    for model in MODELS:
        images = creator_images(model["modelId"])
        folder = out / model["id"]
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("*"):
            if old.is_file():
                old.unlink()
        saved = []
        for index, image in enumerate(images, start=1):
            data = download(image["url"])
            if not sniff(data):
                print("skip", model["id"], index, "unknown type")
                continue
            name = f"{index:02d}.jpg"
            target = folder / name
            save_jpeg(data, target)
            saved.append(f"{model['id']}/{name}")
            print(model["id"], name, target.stat().st_size)
        print(model["id"], "kept", len(saved))
        items.append(
            {
                "id": model["id"],
                "name": model["name"],
                "base": model["base"],
                "summary": model["summary"].strip(),
                "url": model["url"],
                "images": saved,
            }
        )
    manifest = out / "manifest.json"
    manifest.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", manifest)


if __name__ == "__main__":
    main()
