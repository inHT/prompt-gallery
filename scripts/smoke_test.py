# -*- coding: utf-8 -*-
"""对已启动的本地服务做一次接口检查。"""

import json
import struct
import urllib.error
import urllib.request
import zlib

BASE = "http://127.0.0.1:8765"
SAMPLE = (
    "a cat in the rain, oil painting\n"
    "Negative prompt: blur, watermark\n"
    "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 512x768, Model: demo"
)


def request(method, path, data=None, headers=None):
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read()
            return response.status, dict(response.headers), body
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def png_chunk(tag, payload):
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)


def tiny_png():
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\x00\x00")
    text = b"parameters\x00" + SAMPLE.encode("utf-8")
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"tEXt", text)
        + png_chunk(b"IDAT", idat)
        + png_chunk(b"IEND", b"")
    )


def main():
    status, _headers, body = request("GET", "/api/health")
    health = json.loads(body)
    assert status == 200 and health["hasKey"] and not health["hasAppId"], health

    status, _headers, body = request("GET", "/")
    html = body.decode("utf-8")
    assert status == 200 and "看图，读提示词" in html

    status, _headers, _body = request("GET", "/%E7%99%BE%E5%BA%A6%E7%BF%BB%E8%AF%91api.txt")
    assert status == 404

    status, headers, body = request("GET", "/samples/01.jpg")
    assert status == 200 and headers.get("Content-Type") == "image/jpeg" and body[:2] == b"\xff\xd8"

    status, _headers, body = request("GET", "/api/gallery")
    gallery = json.loads(body)
    assert len(gallery["items"]) == 6, len(gallery["items"])
    by_id = {item["id"]: item for item in gallery["items"]}
    assert len(by_id["sample-01"]["positive"]) > 100
    assert by_id["sample-01"]["translation"] == ""
    assert by_id["sample-05"]["translationFrom"] == "copy"
    assert by_id["sample-05"]["translation"].startswith("一张")
    assert by_id["sample-01"]["source"] == "ComfyUI"
    assert by_id["sample-01"]["negative"]

    status, _headers, body = request(
        "POST",
        "/api/upload",
        tiny_png(),
        {"Content-Type": "image/png", "X-Filename": "cat.png"},
    )
    uploaded = json.loads(body)
    assert status == 200, uploaded
    item = uploaded["item"]
    assert item["positive"].startswith("a cat"), item
    assert "blur" in item["negative"]
    assert item["meta"]["seed"] == "42"
    assert item["source"] == "Stable Diffusion WebUI"

    status, _headers, body = request(
        "PATCH",
        "/api/items/" + item["id"],
        json.dumps({"translation": "雨中的猫，油画"}, ensure_ascii=False).encode("utf-8"),
        {"Content-Type": "application/json"},
    )
    patched = json.loads(body)
    assert patched["item"]["translation"] == "雨中的猫，油画"
    assert patched["item"]["translationFrom"] == "manual"
    assert patched["item"]["positive"].startswith("a cat")

    status, _headers, body = request(
        "POST",
        "/api/items/" + item["id"] + "/translate",
        b"{}",
        {"Content-Type": "application/json"},
    )
    skipped = json.loads(body)
    assert status == 200, skipped
    assert skipped["item"]["translation"] == "雨中的猫，油画"

    status, _headers, body = request(
        "POST",
        "/api/items/sample-02/translate",
        b"{}",
        {"Content-Type": "application/json"},
    )
    failed = json.loads(body)
    assert status == 502 and "APP ID" in failed["error"], failed

    status, _headers, body = request(
        "POST",
        "/api/settings",
        json.dumps({"appid": "not-a-number"}).encode("utf-8"),
        {"Content-Type": "application/json"},
    )
    assert status == 400 and "数字" in json.loads(body)["error"]

    real = open(r"D:\AI\.AI生图\带工作流的图片\ComfyUI_temp_amcqd_00007_.png", "rb").read()
    status, _headers, body = request(
        "POST",
        "/api/upload",
        real,
        {"Content-Type": "image/png", "X-Filename": "asuka.png"},
    )
    comfy = json.loads(body)
    assert status == 200, comfy
    assert "Asuka" in comfy["item"]["positive"], comfy["item"]["positive"][:80]
    assert comfy["item"]["meta"].get("model")

    for item_id in (item["id"], comfy["item"]["id"]):
        status, _headers, body = request("DELETE", "/api/items/" + item_id)
        assert status == 200, body

    status, _headers, body = request("GET", "/api/gallery")
    ids = {entry["id"] for entry in json.loads(body)["items"]}
    assert item["id"] not in ids and comfy["item"]["id"] not in ids
    assert "sample-01" in ids
    print("smoke ok", len(ids), "items")


if __name__ == "__main__":
    main()
