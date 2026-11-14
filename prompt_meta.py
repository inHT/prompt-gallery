# -*- coding: utf-8 -*-
"""从 PNG / JPEG / WebP 里读出 AI 绘图提示词。只用标准库。"""

from __future__ import annotations

import json
import re
import struct
import zlib

MAX_TEXT = 80_000


def extract_bytes(data: bytes, filename: str = "") -> dict:
    """返回 positive、negative、source、meta、warning。"""
    width = height = None
    texts: dict[str, str] = {}
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        texts, width, height = read_png(data)
    elif data.startswith(b"\xff\xd8"):
        texts, width, height = read_jpeg(data)
    elif len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        texts, width, height = read_webp(data)
    else:
        return empty_result(
            "这张图不是 PNG、JPEG 或 WebP，读不到常见的提示词元数据。",
            width,
            height,
        )

    parsed = interpret(texts)
    if not parsed or not (parsed.get("positive") or parsed.get("negative")):
        return empty_result(
            "没有在这张图里找到 ComfyUI、WebUI 或 NovelAI 的提示词。可以把原文贴到左边。",
            width,
            height,
        )
    meta = dict(parsed.get("meta") or {})
    if width and not meta.get("width"):
        meta["width"] = width
    if height and not meta.get("height"):
        meta["height"] = height
    parsed["meta"] = clean_meta(meta)
    parsed["positive"] = (parsed.get("positive") or "").strip()[:MAX_TEXT]
    parsed["negative"] = (parsed.get("negative") or "").strip()[:MAX_TEXT]
    parsed["warning"] = ""
    parsed["source"] = parsed.get("source") or "图片元数据"
    return parsed


def empty_result(warning: str, width, height) -> dict:
    meta = {}
    if width:
        meta["width"] = width
    if height:
        meta["height"] = height
    return {
        "positive": "",
        "negative": "",
        "source": "",
        "meta": clean_meta(meta),
        "warning": warning,
    }


def clean_meta(meta: dict) -> dict:
    out = {}
    for key, value in meta.items():
        if value in ("", None, [], {}):
            continue
        if key == "loras" and isinstance(value, list):
            names = []
            for item in value:
                text = str(item).strip()
                if text and text not in names:
                    names.append(text)
            if names:
                out["loras"] = names[:24]
            continue
        if key == "seed":
            out["seed"] = str(value)
            continue
        if isinstance(value, (int, float, str)):
            out[key] = value
    return out


def interpret(texts: dict[str, str]) -> dict | None:
    priority = [
        "parameters",
        "prompt",
        "Comment",
        "Description",
        "sd-metadata",
        "invokeai_metadata",
        "invokeai",
        "InvokeAI_metadata",
    ]
    ordered = [key for key in priority if texts.get(key)]
    ordered += [key for key in texts if key not in ordered and key != "workflow"]

    for key in ordered:
        got = try_structured(key, texts[key])
        if got and (got.get("positive") or got.get("negative")):
            return got

    if texts.get("workflow"):
        got = from_workflow(texts["workflow"])
        if got:
            return got

    best = ""
    for key, value in texts.items():
        if key == "workflow":
            continue
        if looks_like_prompt(value) and len(value) > len(best):
            best = value
    if best:
        return plain(best[:MAX_TEXT], "图片元数据")
    return None


def try_structured(key: str, value: str) -> dict | None:
    if not value:
        return None
    if key == "parameters":
        return parse_a1111(value) or parse_json_prompt(value)
    if key == "prompt":
        got = parse_json_prompt(value)
        if got and got.get("positive"):
            return got
        stripped = value.strip()
        if stripped and not stripped.startswith("{") and len(stripped) > 8:
            return plain(stripped, "图片元数据")
        return None
    got = parse_a1111(value) or parse_json_prompt(value)
    if got and got.get("positive"):
        if key in ("Comment", "Description") and got.get("source") == "图片元数据":
            got["source"] = "NovelAI"
        return got
    return None


def plain(text: str, source: str) -> dict:
    return {
        "positive": text.strip()[:MAX_TEXT],
        "negative": "",
        "source": source,
        "meta": {},
    }


def looks_like_prompt(text: str) -> bool:
    stripped = (text or "").strip()
    if len(stripped) < 24 or len(stripped) > MAX_TEXT:
        return False
    if stripped.startswith("{") or stripped.startswith("<"):
        return False
    if stripped.startswith("http://") or stripped.startswith("https://"):
        return False
    lower = stripped.lower()
    if lower.endswith((".safetensors", ".ckpt", ".pt", ".png", ".jpg", ".jpeg", ".webp")):
        return False
    return True


def parse_a1111(text: str) -> dict | None:
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if "Steps:" not in text and "Negative prompt:" not in text:
        return None
    negative = ""
    meta_line = ""
    positive = text
    if "\nNegative prompt:" in text:
        positive, rest = text.split("\nNegative prompt:", 1)
        if "\nSteps:" in rest:
            negative, meta_line = rest.split("\nSteps:", 1)
            meta_line = "Steps:" + meta_line
        else:
            negative = rest
    elif "\nSteps:" in text:
        positive, meta_line = text.split("\nSteps:", 1)
        meta_line = "Steps:" + meta_line
    positive = positive.strip()
    negative = negative.strip()
    if not positive and not negative:
        return None
    return {
        "positive": positive,
        "negative": negative,
        "source": "Stable Diffusion WebUI",
        "meta": parse_meta_line(meta_line),
    }


def parse_meta_line(line: str) -> dict:
    meta = {}
    if not line:
        return meta
    patterns = (
        ("steps", r"Steps:\s*(\d+)"),
        ("sampler", r"Sampler:\s*([^,\n]+)"),
        ("cfg", r"CFG scale:\s*([0-9.]+)"),
        ("seed", r"Seed:\s*(\d+)"),
        ("size", r"Size:\s*(\d+)x(\d+)"),
        ("model", r"(?<![\w])Model:\s*([^,\n]+)"),
        ("scheduler", r"Schedule type:\s*([^,\n]+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, line)
        if not match:
            continue
        if key == "size":
            meta["width"] = int(match.group(1))
            meta["height"] = int(match.group(2))
        elif key == "steps":
            meta["steps"] = int(match.group(1))
        elif key == "cfg":
            meta["cfg"] = float(match.group(1)) if "." in match.group(1) else int(match.group(1))
        else:
            meta[key] = match.group(1).strip()
    return meta


def parse_json_prompt(text: str, source_hint: str = "") -> dict | None:
    stripped = text.strip()
    if not stripped.startswith("{") and not stripped.startswith("["):
        return None
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    if isinstance(obj, dict) and is_comfy_prompt(obj):
        return extract_comfy(obj)
    found = dig_prompt(obj)
    if not found:
        return None
    if source_hint and found.get("source") in ("", "图片元数据"):
        found["source"] = source_hint
    return found


def dig_prompt(obj, depth: int = 0) -> dict | None:
    if depth > 5 or not isinstance(obj, dict):
        return None
    prompt = obj.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        negative = obj.get("negative_prompt") or obj.get("negative") or obj.get("uc") or ""
        meta = {}
        if obj.get("seed") is not None:
            meta["seed"] = obj.get("seed")
        if obj.get("steps") is not None:
            meta["steps"] = obj.get("steps")
        if obj.get("sampler"):
            meta["sampler"] = obj.get("sampler")
        if obj.get("cfg") is not None:
            meta["cfg"] = obj.get("cfg")
        elif obj.get("scale") is not None:
            meta["cfg"] = obj.get("scale")
        if obj.get("model"):
            meta["model"] = obj.get("model")
        source = "NovelAI" if "uc" in obj else "图片元数据"
        return {
            "positive": prompt.strip(),
            "negative": str(negative).strip() if not isinstance(negative, (dict, list)) else "",
            "source": source,
            "meta": meta,
        }
    image = obj.get("image")
    if isinstance(image, dict):
        prompts = image.get("prompt")
        if isinstance(prompts, list):
            parts = []
            for part in prompts:
                if isinstance(part, dict) and isinstance(part.get("prompt"), str):
                    parts.append(part["prompt"])
                elif isinstance(part, str):
                    parts.append(part)
            if parts:
                negative = image.get("negative_prompt") or ""
                return {
                    "positive": "\n".join(parts).strip(),
                    "negative": str(negative).strip() if not isinstance(negative, (dict, list)) else "",
                    "source": "InvokeAI",
                    "meta": {},
                }
        nested = dig_prompt(image, depth + 1)
        if nested:
            nested["source"] = "InvokeAI"
            return nested
    for key in ("GenerationInfo", "generation", "metadata"):
        if isinstance(obj.get(key), dict):
            nested = dig_prompt(obj[key], depth + 1)
            if nested:
                return nested
    return None


def is_comfy_prompt(obj: dict) -> bool:
    values = list(obj.values())[:12]
    return any(isinstance(item, dict) and "class_type" in item for item in values)


def extract_comfy(prompt: dict) -> dict | None:
    best_pos = ""
    best_neg = ""
    best_sampler = None
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type") or ""
        inputs = node.get("inputs") or {}
        if "Sampler" not in class_type or not isinstance(inputs.get("positive"), list):
            continue
        positive = walk(prompt, inputs.get("positive"))
        negative = walk(prompt, inputs.get("negative")) if isinstance(inputs.get("negative"), list) else ""
        if len(positive) > len(best_pos):
            best_pos = positive
            best_sampler = node
        if len(negative) > len(best_neg):
            best_neg = negative
    if not best_pos:
        return None
    meta = collect_models(prompt)
    if best_sampler:
        inputs = best_sampler.get("inputs") or {}
        if inputs.get("seed") is not None and not isinstance(inputs.get("seed"), list):
            meta["seed"] = inputs.get("seed")
        if inputs.get("steps") is not None and not isinstance(inputs.get("steps"), list):
            meta["steps"] = inputs.get("steps")
        if inputs.get("cfg") is not None and not isinstance(inputs.get("cfg"), list):
            meta["cfg"] = inputs.get("cfg")
        if isinstance(inputs.get("sampler_name"), str):
            meta["sampler"] = inputs["sampler_name"]
        if isinstance(inputs.get("scheduler"), str):
            meta["scheduler"] = inputs["scheduler"]
        size = latent_size(prompt, inputs.get("latent_image"))
        if size:
            meta["width"], meta["height"] = size
    return {
        "positive": best_pos.strip(),
        "negative": best_neg.strip(),
        "source": "ComfyUI",
        "meta": meta,
    }


def is_lora_loader(class_type: str) -> bool:
    lowered = (class_type or "").lower()
    compact = lowered.replace(" ", "")
    return "loraloader" in compact or "lora loader" in lowered


def node_text(node: dict) -> str:
    inputs = node.get("inputs") or {}
    if is_lora_loader(node.get("class_type") or ""):
        return ""
    for key in ("positive", "text", "prompt", "value", "string"):
        value = inputs.get(key)
        if not isinstance(value, str):
            continue
        stripped = value.strip()
        if len(stripped) <= 8:
            continue
        lower = stripped.lower()
        if lower.endswith((".safetensors", ".ckpt", ".pt", ".png", ".jpg", ".jpeg", ".webp")):
            continue
        if '"isLoraTag"' in stripped or '"isPunctuation"' in stripped:
            continue
        if stripped.startswith("<lora:") and stripped.endswith(">") and " " not in stripped:
            continue
        return stripped
    return ""


def walk(prompt: dict, link, depth: int = 0, seen: set | None = None) -> str:
    if not link or depth > 16:
        return ""
    if seen is None:
        seen = set()
    node_id = str(link[0])
    if node_id in seen or node_id not in prompt:
        return ""
    seen.add(node_id)
    node = prompt[node_id]
    if not isinstance(node, dict):
        return ""
    class_type = node.get("class_type") or ""
    if "ConditioningZeroOut" in class_type:
        return ""
    found = node_text(node)
    if found:
        return found
    prefer = []
    other = []
    for key, value in (node.get("inputs") or {}).items():
        if isinstance(value, list) and len(value) >= 2 and isinstance(value[0], (str, int)):
            if key.lower() in (
                "positive",
                "negative",
                "conditioning",
                "conditioning1",
                "conditioning2",
                "text",
                "string",
                "value",
                "prompt",
                "clip",
            ):
                prefer.append(value)
            else:
                other.append(value)
    for nxt in prefer + other:
        got = walk(prompt, nxt, depth + 1, seen)
        if got:
            return got
    return ""


def latent_size(prompt: dict, link, depth: int = 0, seen: set | None = None):
    if not link or depth > 12:
        return None
    if seen is None:
        seen = set()
    node_id = str(link[0])
    if node_id in seen or node_id not in prompt:
        return None
    seen.add(node_id)
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs") or {}
    width, height = inputs.get("width"), inputs.get("height")
    if isinstance(width, (int, float)) and isinstance(height, (int, float)) and width > 16 and height > 16:
        if not isinstance(width, list) and not isinstance(height, list):
            return int(width), int(height)
    for value in inputs.values():
        if isinstance(value, list) and value and isinstance(value[0], (str, int)):
            got = latent_size(prompt, value, depth + 1, seen)
            if got:
                return got
    return None


def collect_models(prompt: dict) -> dict:
    models = []
    loras = []
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type") or ""
        inputs = node.get("inputs") or {}
        if class_type in ("UNETLoader", "UnetLoaderGGUF", "CheckpointLoaderSimple"):
            for key in ("unet_name", "ckpt_name"):
                if isinstance(inputs.get(key), str):
                    models.append(base_name(inputs[key]))
        if is_lora_loader(class_type):
            if isinstance(inputs.get("lora_name"), str):
                loras.append(base_name(inputs["lora_name"]))
            text = inputs.get("text") if isinstance(inputs.get("text"), str) else ""
            loras.extend(re.findall(r"<lora:([^:>]+)", text))
    unique_models = unique(models)
    return {"model": unique_models[0] if unique_models else "", "loras": unique(loras)[:24]}


def from_workflow(text: str) -> dict | None:
    try:
        workflow = json.loads(text)
    except json.JSONDecodeError:
        return None
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list):
        return None
    positive = ""
    negative = ""
    for node in nodes:
        if not isinstance(node, dict):
            continue
        label = f"{node.get('type') or ''} {node.get('title') or ''}"
        if widget_text_is_linked(node):
            continue
        texts = []
        for value in node.get("widgets_values") or []:
            if isinstance(value, str) and usable_widget_text(value):
                texts.append(value.strip())
        if not texts:
            continue
        chosen = max(texts, key=len)
        if re.search(r"negative|负向|Negative", label, re.I):
            if len(chosen) > len(negative):
                negative = chosen
        elif re.search(r"CLIPText|Prompt|WeiLin|positive|正向|T5Text|PrimitiveString|StringMultiline", label, re.I):
            if len(chosen) > len(positive):
                positive = chosen
    if not positive:
        return None
    return {
        "positive": positive,
        "negative": negative,
        "source": "ComfyUI",
        "meta": {},
    }


def widget_text_is_linked(node: dict) -> bool:
    """文本输入已经接到别的节点时，控件里留下的是旧示例，不能当成这张图的提示词。"""
    for item in node.get("inputs") or []:
        if not isinstance(item, dict) or item.get("link") is None:
            continue
        if item.get("name") in ("text", "value", "prompt", "positive", "string"):
            return True
    return False


def usable_widget_text(text: str) -> bool:
    stripped = text.strip()
    if len(stripped) < 12:
        return False
    if '"isLoraTag"' in stripped or '"isPunctuation"' in stripped:
        return False
    if stripped.startswith("<lora:") and " " not in stripped:
        return False
    lower = stripped.lower()
    if lower.endswith((".safetensors", ".ckpt", ".pt", ".png", ".jpg")):
        return False
    return True


def unique(items: list[str]) -> list[str]:
    seen = set()
    result = []
    for item in items:
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def base_name(path: str) -> str:
    return path.replace("\\", "/").split("/")[-1]


def read_png(data: bytes) -> tuple[dict[str, str], int | None, int | None]:
    texts: dict[str, str] = {}
    width = height = None
    index = 8
    while index + 12 <= len(data):
        length = struct.unpack(">I", data[index : index + 4])[0]
        if length > len(data) - (index + 12):
            break
        ctype = data[index + 4 : index + 8]
        chunk = data[index + 8 : index + 8 + length]
        index += 12 + length
        if ctype == b"IHDR" and len(chunk) >= 8:
            width, height = struct.unpack(">II", chunk[:8])
        elif ctype == b"tEXt":
            key, _, value = chunk.partition(b"\x00")
            texts[decode_key(key)] = value.decode("utf-8", "replace")
        elif ctype == b"zTXt":
            key, _, rest = chunk.partition(b"\x00")
            if len(rest) >= 2 and rest[0] == 0:
                try:
                    texts[decode_key(key)] = zlib.decompress(rest[1:]).decode("utf-8", "replace")
                except zlib.error:
                    pass
        elif ctype == b"iTXt":
            decoded = decode_itxt(chunk)
            if decoded:
                texts[decoded[0]] = decoded[1]
        if ctype == b"IEND":
            break
    return texts, width, height


def decode_itxt(chunk: bytes) -> tuple[str, str] | None:
    key, _, rest = chunk.partition(b"\x00")
    if len(rest) < 2:
        return None
    compressed = rest[0]
    rest = rest[2:]
    _lang, _, rest = rest.partition(b"\x00")
    _translated, _, text = rest.partition(b"\x00")
    try:
        if compressed:
            text = zlib.decompress(text)
        return decode_key(key), text.decode("utf-8", "replace")
    except zlib.error:
        return None


def decode_key(key: bytes) -> str:
    return key.decode("latin1", "replace")


def read_jpeg(data: bytes) -> tuple[dict[str, str], int | None, int | None]:
    texts: dict[str, str] = {}
    width = height = None
    index = 2
    serial = 0

    def add(prefix: str, text: str) -> None:
        nonlocal serial
        cleaned = text.replace("\x00", "").strip()
        if len(cleaned) > 8:
            texts[f"{prefix}{serial}"] = cleaned
            serial += 1

    while index + 4 <= len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        while index < len(data) and data[index] == 0xFF:
            index += 1
        if index >= len(data):
            break
        marker = data[index]
        index += 1
        if marker in (0xD8, 0xD9):
            if marker == 0xD9:
                break
            continue
        if marker == 0x00 or 0xD0 <= marker <= 0xD7:
            continue
        if index + 2 > len(data):
            break
        segment_length = struct.unpack(">H", data[index : index + 2])[0]
        if segment_length < 2 or index + segment_length > len(data):
            break
        payload = data[index + 2 : index + segment_length]
        index += segment_length
        if marker == 0xDA:
            break
        if marker == 0xFE:
            add("com", payload.decode("utf-8", "replace"))
        elif marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            for text in tiff_strings(payload[6:]):
                add("exif", text)
        elif marker == 0xE1 and payload.startswith(b"http://ns.adobe.com/xap/1.0/\x00"):
            xmp = payload.split(b"\x00", 1)[-1].decode("utf-8", "replace")
            plain_xmp = xmp_to_text(xmp)
            if plain_xmp:
                add("xmp", plain_xmp)
        elif marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if height is None and len(payload) >= 5:
                height = struct.unpack(">H", payload[1:3])[0]
                width = struct.unpack(">H", payload[3:5])[0]
    return texts, width, height


def read_webp(data: bytes) -> tuple[dict[str, str], int | None, int | None]:
    texts: dict[str, str] = {}
    width = height = None
    index = 12
    serial = 0
    while index + 8 <= len(data):
        chunk_id = data[index : index + 4]
        size = struct.unpack("<I", data[index + 4 : index + 8])[0]
        start = index + 8
        if start + size > len(data):
            break
        chunk = data[start : start + size]
        index = start + size + (size & 1)
        if chunk_id == b"VP8X" and len(chunk) >= 10:
            width = 1 + int.from_bytes(chunk[4:7], "little")
            height = 1 + int.from_bytes(chunk[7:10], "little")
        elif chunk_id == b"EXIF":
            blob = chunk[6:] if chunk.startswith(b"Exif\x00\x00") else chunk
            for text in tiff_strings(blob):
                texts[f"exif{serial}"] = text
                serial += 1
        elif chunk_id == b"XMP ":
            plain_xmp = xmp_to_text(chunk.decode("utf-8", "replace"))
            if plain_xmp:
                texts[f"xmp{serial}"] = plain_xmp
                serial += 1
    return texts, width, height


def xmp_to_text(xmp: str) -> str:
    if "Negative prompt:" not in xmp and "Steps:" not in xmp and '"prompt"' not in xmp:
        return ""
    plain_text = re.sub(r"<[^>]+>", "\n", xmp)
    plain_text = (
        plain_text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return plain_text.strip()


def tiff_strings(tiff: bytes) -> list[str]:
    if len(tiff) < 8:
        return []
    if tiff[:2] == b"II":
        order = "<"
    elif tiff[:2] == b"MM":
        order = ">"
    else:
        return []

    def u16(offset: int) -> int:
        return struct.unpack_from(order + "H", tiff, offset)[0]

    def u32(offset: int) -> int:
        return struct.unpack_from(order + "I", tiff, offset)[0]

    if u16(2) != 42:
        return []
    found: list[str] = []

    def walk_ifd(offset: int, depth: int = 0) -> None:
        if depth > 4 or offset <= 0 or offset + 2 > len(tiff):
            return
        count = u16(offset)
        entry = offset + 2
        exif_offset = None
        for _ in range(count):
            if entry + 12 > len(tiff):
                break
            tag = u16(entry)
            typ = u16(entry + 2)
            count_values = u32(entry + 4)
            type_size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}.get(typ, 1)
            nbytes = type_size * count_values
            if nbytes <= 4:
                data_offset = entry + 8
            else:
                data_offset = u32(entry + 8)
            if tag == 0x8769 and typ in (4, 9):
                exif_offset = u32(entry + 8)
            if tag in (0x010E, 0x9286, 0x9C9C) and 0 <= data_offset < len(tiff):
                raw = tiff[data_offset : data_offset + max(0, nbytes)]
                text = decode_exif_text(tag, raw, order)
                if text and len(text.strip()) > 8:
                    found.append(text.strip())
            entry += 12
        if exif_offset:
            walk_ifd(exif_offset, depth + 1)
        if entry + 4 <= len(tiff):
            nxt = u32(entry)
            if nxt and nxt != offset:
                walk_ifd(nxt, depth + 1)

    walk_ifd(u32(4))
    return found


def decode_exif_text(tag: int, raw: bytes, order: str) -> str:
    if tag == 0x9286 and len(raw) >= 8:
        charset = raw[:8]
        body = raw[8:]
        if charset.startswith(b"ASCII") or charset == b"\x00" * 8:
            return body.split(b"\x00", 1)[0].decode("utf-8", "replace")
        if charset.startswith(b"UNICODE"):
            encoding = "utf-16le" if order == "<" else "utf-16be"
            return body.decode(encoding, "replace").rstrip("\x00")
        return body.decode("utf-8", "replace")
    if tag == 0x9C9C:
        return raw.decode("utf-16le", "replace").rstrip("\x00")
    return raw.split(b"\x00", 1)[0].decode("utf-8", "replace")


def _self_test() -> None:
    from pathlib import Path

    sample = (
        "a cat in the rain, oil painting\n"
        "Negative prompt: blur, watermark\n"
        "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 512x768, Model: demo"
    )
    comment = sample.encode("utf-8")
    jpeg = b"\xff\xd8" + b"\xff\xfe" + struct.pack(">H", len(comment) + 2) + comment + b"\xff\xd9"
    parsed = extract_bytes(jpeg, "note.jpg")
    assert parsed["positive"].startswith("a cat"), parsed
    assert "blur" in parsed["negative"]
    assert parsed["meta"].get("seed") == "42"
    assert parsed["meta"].get("width") == 512
    assert parsed["source"] == "Stable Diffusion WebUI"

    body = sample.encode("utf-16le")
    raw = b"UNICODE\x00" + body
    ifd_start = 8
    data_off = ifd_start + 2 + 12 + 4
    tiff = bytearray(b"II" + struct.pack("<H", 42) + struct.pack("<I", ifd_start))
    tiff += struct.pack("<H", 1)
    tiff += struct.pack("<HHI", 0x9286, 7, len(raw))
    tiff += struct.pack("<I", data_off)
    tiff += struct.pack("<I", 0)
    tiff += raw
    exif_payload = b"Exif\x00\x00" + bytes(tiff)
    exif_jpeg = b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(exif_payload) + 2) + exif_payload + b"\xff\xd9"
    parsed = extract_bytes(exif_jpeg, "exif.jpg")
    assert parsed["positive"].startswith("a cat"), parsed
    assert parsed["meta"].get("height") == 768

    def png_chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\x00\x00")
    ztext = b"parameters\x00\x00" + zlib.compress(sample.encode("utf-8"))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"zTXt", ztext)
        + png_chunk(b"IDAT", idat)
        + png_chunk(b"IEND", b"")
    )
    parsed = extract_bytes(png, "z.png")
    assert parsed["positive"].startswith("a cat"), parsed
    assert parsed["meta"].get("width") == 512

    root = Path(r"D:\AI\.AI生图\带工作流的图片")
    if root.exists():
        files = sorted(root.glob("*.png"))
        assert files, "测试目录里没有 PNG"
        short = []
        for path in files:
            result = extract_bytes(path.read_bytes(), path.name)
            if len(result["positive"]) < 40:
                short.append((path.name, len(result["positive"]), result["warning"]))
        if short:
            raise SystemExit("这些图没有读出足够长的提示词: " + repr(short[:5]))
        print(f"ok {len(files)} comfy pngs, jpeg/exif/ztxt")
    else:
        print("ok jpeg/exif/ztxt (comfy folder missing)")


if __name__ == "__main__":
    _self_test()
