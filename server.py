# -*- coding: utf-8 -*-
"""本地图库服务：静态页面、读取图片提示词、代理百度翻译、保存译文。"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import prompt_meta

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
IMAGES = DATA / "images"
GALLERY_PATH = DATA / "gallery.json"
CRED_PATH = ROOT / "百度翻译api.txt"
MANIFEST_PATH = PUBLIC / "samples" / "manifest.json"
LORA_PATH = DATA / "loras.json"
LORA_IMAGES = DATA / "lora-images"
LORA_MANIFEST = PUBLIC / "lora-samples" / "manifest.json"

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()
MAX_UPLOAD = 40 * 1024 * 1024
BAIDU_URL = "https://fanyi-api.baidu.com/api/trans/vip/translate"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MEDIA_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|webp)$")
LORA_SAMPLE_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}/[0-9]{2}\.(jpg|png|webp)$")
MAX_LORA_IMAGES = 8
MAX_SAMPLE_IMAGES = 24
MAX_LORA_SUMMARY = 12000

GALLERY_LOCK = threading.Lock()
LORA_LOCK = threading.Lock()
PACE_LOCK = threading.Lock()
LAST_BAIDU_CALL = 0.0

BAIDU_ERRORS = {
    "52001": "百度翻译请求超时，请重试",
    "52002": "百度翻译暂时出错，请重试",
    "52003": "未授权：请检查 APP ID 是否正确，以及是否已开通「通用翻译API」",
    "54000": "翻译参数为空",
    "54001": "签名错误，请检查密钥",
    "54003": "访问太频繁，请稍后再试",
    "54004": "百度翻译账户余额不足或额度用完",
    "54005": "长文本请求太频繁，请几秒后再试",
    "58000": "服务器出口 IP 不在百度翻译的 IP 白名单里。白名单要填这台服务器的公网 IP，或者留空",
    "58001": "这个语言方向不受支持",
    "58002": "百度翻译服务当前已关闭",
    "58003": "当前 IP 被百度临时限制，明天会解除，或联系百度翻译",
    "90107": "百度开发者认证未通过或还没生效",
    "20003": "这段文本没通过百度内容安全检查",
}


class TranslateError(Exception):
    pass


def load_credentials() -> tuple[str, str]:
    appid = os.environ.get("BAIDU_APPID", "").strip()
    key = os.environ.get("BAIDU_KEY", "").strip()
    if not CRED_PATH.exists():
        return appid, key
    for raw_line in CRED_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            name, value = line.split("=", 1)
            name = name.strip().lower()
            value = value.strip()
            if name in ("appid", "app_id", "id") and not appid:
                appid = value
            elif name in ("key", "secret", "appkey", "密钥") and not key:
                key = value
            continue
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit():
            appid = appid or parts[0]
            key = key or parts[1]
            continue
        if line.isdigit() and not appid:
            appid = line
        elif not key:
            key = line
    return appid, key


def save_credentials(appid: str, key: str) -> None:
    CRED_PATH.write_text(
        "\n".join(
            [
                "# 百度翻译开放平台凭据",
                "# https://fanyi-api.baidu.com/manage/developer",
                "# 此文件放在项目根目录。网页目录 public 不会提供它。",
                "# 环境变量 BAIDU_APPID / BAIDU_KEY 若已设置，会覆盖这里的值。",
                f"appid={appid}",
                f"key={key}",
                "",
            ]
        ),
        encoding="utf-8",
    )


def credential_status() -> dict:
    appid, key = load_credentials()
    return {"hasAppId": bool(appid), "hasKey": bool(key)}


def cjk_ratio(text: str) -> float:
    cjk = 0
    letters = 0
    for char in text or "":
        if "\u4e00" <= char <= "\u9fff":
            cjk += 1
            letters += 1
        elif char.isascii() and char.isalpha():
            letters += 1
    if letters == 0:
        return 0.0
    return cjk / letters


def decorate_new_item(item: dict) -> dict:
    item.setdefault("translation", "")
    item.setdefault("negativeTranslation", "")
    item.setdefault("translationFrom", "")
    item.setdefault("negativeFrom", "")
    item.setdefault("warning", "")
    item.setdefault("meta", {})
    item.setdefault("sample", False)
    if not item["translation"] and cjk_ratio(item.get("positive") or "") >= 0.45:
        item["translation"] = item["positive"]
        item["translationFrom"] = "copy"
    negative = item.get("negative") or ""
    if negative and not item["negativeTranslation"] and cjk_ratio(negative) >= 0.45:
        item["negativeTranslation"] = negative
        item["negativeFrom"] = "copy"
    return item


def manifest_items() -> list[dict]:
    if not MANIFEST_PATH.exists():
        return []
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    now = time.time()
    items = []
    for index, row in enumerate(raw.get("items") or []):
        image = row.get("image") or ""
        if image and not image.startswith("/"):
            image = "/samples/" + image
        items.append(
            decorate_new_item(
                {
                    "id": row["id"],
                    "name": row.get("name") or row["id"],
                    "created": now - index,
                    "image": image,
                    "sample": True,
                    "positive": row.get("positive") or "",
                    "negative": row.get("negative") or "",
                    "source": row.get("source") or "",
                    "meta": row.get("meta") or {},
                    "translation": row.get("translation") or "",
                    "negativeTranslation": row.get("negativeTranslation") or "",
                    "translationFrom": row.get("translationFrom") or "",
                    "negativeFrom": row.get("negativeFrom") or "",
                    "warning": row.get("warning") or "",
                }
            )
        )
    return items


def empty_gallery() -> dict:
    return {"items": manifest_items()}


def load_gallery() -> dict:
    if not GALLERY_PATH.exists():
        data = empty_gallery()
        save_gallery(data)
        return data
    data = json.loads(GALLERY_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise RuntimeError("data/gallery.json 格式不对")
    return data


def save_gallery(data: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    temporary = GALLERY_PATH.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(GALLERY_PATH)


def public_item(item: dict) -> dict:
    keep = (
        "id",
        "name",
        "created",
        "image",
        "sample",
        "positive",
        "negative",
        "source",
        "meta",
        "translation",
        "negativeTranslation",
        "translationFrom",
        "negativeFrom",
        "warning",
    )
    return {key: item.get(key) for key in keep}


def find_item(data: dict, item_id: str) -> dict | None:
    for item in data["items"]:
        if item.get("id") == item_id:
            return item
    return None


def split_chunks(text: str, limit: int = 4500) -> list[str]:
    def size(value: str) -> int:
        return len(value.encode("utf-8"))

    if not text:
        return []
    if size(text) <= limit:
        return [text]
    parts: list[str] = []
    current = ""
    for paragraph in text.split("\n"):
        addition = paragraph if not current else "\n" + paragraph
        if size(current) + size(addition) <= limit:
            current += addition
            continue
        if current:
            parts.append(current)
            current = ""
        if size(paragraph) <= limit:
            current = paragraph
            continue
        buffer = ""
        for char in paragraph:
            if size(buffer) + size(char) > limit:
                parts.append(buffer)
                buffer = char
            else:
                buffer += char
                if char in "。！？；" and size(buffer) > int(limit * 0.6):
                    parts.append(buffer)
                    buffer = ""
        current = buffer
    if current:
        parts.append(current)
    return [part for part in parts if part]


def baidu_once(text: str, appid: str, key: str, source: str, target: str) -> str:
    global LAST_BAIDU_CALL
    salt = str(int(time.time() * 1000) % 1_000_000_000 + uuid.uuid4().int % 1000)
    sign = hashlib.md5((appid + text + salt + key).encode("utf-8")).hexdigest()
    body = urllib.parse.urlencode(
        {"q": text, "from": source, "to": target, "appid": appid, "salt": salt, "sign": sign}
    ).encode("utf-8")
    request = urllib.request.Request(
        BAIDU_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "prompt-gallery/1.0",
        },
    )
    with PACE_LOCK:
        wait = LAST_BAIDU_CALL + 1.05 - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            payload = exc.read()
        except urllib.error.URLError as exc:
            LAST_BAIDU_CALL = time.time()
            raise TranslateError("连接百度翻译失败：" + str(exc.reason)) from exc
        LAST_BAIDU_CALL = time.time()
    try:
        data = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise TranslateError("百度翻译返回了无法识别的内容") from exc
    code = str(data.get("error_code") or "")
    if code and code != "52000":
        raise TranslateError(BAIDU_ERRORS.get(code, f"百度翻译错误 {code}"))
    rows = data.get("trans_result") or []
    if not rows:
        raise TranslateError("百度翻译没有返回译文")
    return "\n".join(str(row.get("dst") or "") for row in rows)


def baidu_translate(text: str) -> str:
    appid, key = load_credentials()
    if not appid or not key:
        missing = "APP ID" if not appid else "密钥"
        raise TranslateError(f"还没有配置百度翻译{missing}。点右上角设置补上。")
    parts = split_chunks(text.strip())
    if not parts:
        return ""
    return "\n".join(baidu_once(part, appid, key, "auto", "zh") for part in parts)


def translate_field(current: str, source_text: str, origin: str, force: bool) -> tuple[str, str, str]:
    """返回 (译文, 来源, 警告)。来源：baidu / copy / 原来的。"""
    if not source_text.strip():
        return current or "", origin or "", ""
    if not force and current and origin == "manual":
        return current, origin, ""
    if not force and current:
        return current, origin, ""
    if not force and cjk_ratio(source_text) >= 0.45:
        return source_text, "copy", ""
    try:
        return baidu_translate(source_text), "baidu", ""
    except TranslateError as exc:
        return current or "", origin or "", str(exc)


def clean_filename(name: str) -> str:
    name = urllib.parse.unquote(name or "")
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f]", "", name).strip() or "未命名图片"
    return name[:180]


def sniff_ext(data: bytes, filename: str) -> str:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext == "jpeg":
        ext = "jpg"
    if ext in ("png", "jpg", "webp"):
        return ext
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    raise ValueError("只支持 PNG、JPEG、WebP")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def cookie_map(header: str) -> dict[str, str]:
    found = {}
    for part in (header or "").split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        found[name.strip()] = value.strip()
    return found


def clean_http_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) > 500 or any(char.isspace() for char in value):
        raise ValueError("网址格式不对")
    parts = urllib.parse.urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("网址需要以 http:// 或 https:// 开头")
    return value


def sample_image_url(name: str) -> str:
    name = (name or "").replace("\\", "/").lstrip("/")
    if name.startswith("lora-samples/"):
        name = name[len("lora-samples/") :]
    if not LORA_SAMPLE_RE.match(name):
        return ""
    target = (PUBLIC / "lora-samples" / name).resolve()
    root = (PUBLIC / "lora-samples").resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return ""
    if not target.is_file():
        return ""
    return "/lora-samples/" + name


def lora_manifest_items() -> list[dict]:
    if not LORA_MANIFEST.exists():
        return []
    raw = json.loads(LORA_MANIFEST.read_text(encoding="utf-8"))
    now = time.time()
    items = []
    for index, row in enumerate(raw.get("items") or []):
        item_id = str(row.get("id") or "")
        if not ID_RE.match(item_id):
            continue
        images = []
        for image in row.get("images") or []:
            url = sample_image_url(str(image))
            if url and url not in images:
                images.append(url)
        items.append(
            {
                "id": item_id,
                "name": str(row.get("name") or item_id)[:120],
                "base": str(row.get("base") or "krea2")[:80],
                "summary": str(row.get("summary") or "")[:MAX_LORA_SUMMARY],
                "url": str(row.get("url") or "")[:500],
                "images": images[:MAX_SAMPLE_IMAGES],
                "sample": True,
                "created": now - index,
            }
        )
    return items


def empty_loras() -> dict:
    return {"items": lora_manifest_items()}


def load_loras() -> dict:
    if not LORA_PATH.exists():
        data = empty_loras()
        save_loras(data)
        return data
    data = json.loads(LORA_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise RuntimeError("data/loras.json 格式不对")
    return data


def save_loras(data: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    temporary = LORA_PATH.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(LORA_PATH)


def lora_media_name(url: str) -> str:
    name = (url or "").rsplit("/", 1)[-1]
    return name if MEDIA_RE.match(name) else ""


def public_lora(item: dict) -> dict:
    images = []
    for image in item.get("images") or []:
        if not isinstance(image, str):
            continue
        if image.startswith("/lora-samples/"):
            url = sample_image_url(image)
        elif image.startswith("/lora-media/") and lora_media_name(image):
            url = "/lora-media/" + lora_media_name(image)
        else:
            url = ""
        if url and url not in images:
            images.append(url)
    return {
        "id": item.get("id") or "",
        "name": item.get("name") or "",
        "base": item.get("base") or "",
        "summary": item.get("summary") or "",
        "url": item.get("url") or "",
        "images": images,
        "sample": bool(item.get("sample")),
        "created": item.get("created") or 0,
    }


def find_lora(data: dict, item_id: str) -> dict | None:
    for item in data["items"]:
        if item.get("id") == item_id:
            return item
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "prompt-gallery/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Robots-Tag", "noindex")
        super().end_headers()

    def send_json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def redirect_cross_site(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return False
        host = self.headers.get("Host") or ""
        if urllib.parse.urlparse(origin).netloc != host:
            self.send_json(403, {"ok": False, "error": "拒绝跨站请求"})
            return True
        return False

    def authorized(self) -> bool:
        if not ACCESS_TOKEN:
            return True
        cookies = cookie_map(self.headers.get("Cookie") or "")
        given = cookies.get("access", "")
        return hmac.compare_digest(given, token_hash(ACCESS_TOKEN))

    def require_auth(self) -> bool:
        if self.authorized():
            return True
        self.send_json(401, {"ok": False, "error": "需要访问口令"})
        return False

    def read_body(self, limit: int) -> bytes:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise ValueError("缺少 Content-Length")
        length = int(length_header)
        if length < 0 or length > limit:
            raise ValueError("请求体太大或无效")
        return self.rfile.read(length)

    def read_json(self, limit: int = 1_500_000, optional: bool = False) -> dict:
        raw = self.read_body(limit)
        if not raw:
            if optional:
                return {}
            raise ValueError("请求体是空的")
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("请求体需要是 JSON 对象")
        return data

    def path_only(self) -> str:
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if len(path) > 1 and path.endswith("/"):
            path = path.rstrip("/")
        return path

    def do_GET(self) -> None:
        path = self.path_only()
        if path == "/api/health":
            status = credential_status()
            self.send_json(
                200,
                {
                    "ok": True,
                    "needsAuth": bool(ACCESS_TOKEN),
                    "hasAppId": status["hasAppId"],
                    "hasKey": status["hasKey"],
                },
            )
            return
        if path == "/api/gallery":
            if not self.require_auth():
                return
            try:
                with GALLERY_LOCK:
                    data = load_gallery()
            except (RuntimeError, json.JSONDecodeError) as exc:
                self.send_json(500, {"ok": False, "error": str(exc)})
                return
            items = sorted(data["items"], key=lambda item: item.get("created") or 0, reverse=True)
            self.send_json(200, {"ok": True, "items": [public_item(item) for item in items]})
            return
        if path == "/api/loras":
            if not self.require_auth():
                return
            try:
                with LORA_LOCK:
                    data = load_loras()
            except (RuntimeError, json.JSONDecodeError) as exc:
                self.send_json(500, {"ok": False, "error": str(exc)})
                return
            items = sorted(data["items"], key=lambda item: item.get("created") or 0, reverse=True)
            self.send_json(200, {"ok": True, "items": [public_lora(item) for item in items]})
            return
        if path.startswith("/media/"):
            if not self.require_auth():
                return
            self.serve_media(path[len("/media/") :])
            return
        if path.startswith("/lora-media/"):
            if not self.require_auth():
                return
            self.serve_lora_media(path[len("/lora-media/") :])
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        if self.redirect_cross_site():
            return
        path = self.path_only()
        if path == "/api/login":
            self.handle_login()
            return
        if not self.require_auth():
            return
        try:
            if path == "/api/upload":
                self.handle_upload()
            elif path == "/api/settings":
                self.handle_settings()
            elif path == "/api/samples/restore":
                self.handle_restore()
            elif path.startswith("/api/items/") and path.endswith("/translate"):
                item_id = path[len("/api/items/") : -len("/translate")].strip("/")
                self.handle_translate(item_id)
            elif path == "/api/loras":
                self.handle_lora_create()
            elif path == "/api/loras/restore":
                self.handle_lora_restore()
            elif path.startswith("/api/loras/") and path.endswith("/images"):
                item_id = path[len("/api/loras/") : -len("/images")].strip("/")
                self.handle_lora_image(item_id)
            else:
                self.send_json(404, {"ok": False, "error": "没有这个接口"})
        except ValueError as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except TranslateError as exc:
            self.send_json(502, {"ok": False, "error": str(exc)})

    def do_PATCH(self) -> None:
        if self.redirect_cross_site():
            return
        if not self.require_auth():
            return
        path = self.path_only()
        prefix = "/api/items/"
        if not path.startswith(prefix):
            self.send_json(404, {"ok": False, "error": "没有这个接口"})
            return
        item_id = path[len(prefix) :].strip("/")
        try:
            self.handle_patch(item_id)
        except ValueError as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})

    def do_DELETE(self) -> None:
        if self.redirect_cross_site():
            return
        if not self.require_auth():
            return
        path = self.path_only()
        if path.startswith("/api/loras/"):
            self.handle_lora_delete(path[len("/api/loras/") :].strip("/"))
            return
        prefix = "/api/items/"
        if not path.startswith(prefix):
            self.send_json(404, {"ok": False, "error": "没有这个接口"})
            return
        self.handle_delete(path[len(prefix) :].strip("/"))

    def handle_login(self) -> None:
        if not ACCESS_TOKEN:
            self.send_json(200, {"ok": True, "needsAuth": False})
            return
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"ok": False, "error": "口令格式不对"})
            return
        given = str(body.get("token") or "")
        if not hmac.compare_digest(given, ACCESS_TOKEN):
            self.send_json(401, {"ok": False, "error": "口令不对"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Set-Cookie",
            f"access={token_hash(ACCESS_TOKEN)}; HttpOnly; Path=/; SameSite=Lax",
        )
        data = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_settings(self) -> None:
        body = self.read_json()
        appid, key = load_credentials()
        new_appid = str(body.get("appid") or "").strip() or appid
        new_key = str(body.get("key") or "").strip() or key
        if not new_appid or not new_key:
            raise ValueError("APP ID 和密钥都需要。APP ID 是一串数字，密钥是另一串字符。")
        if not new_appid.isdigit():
            raise ValueError("APP ID 应该是纯数字。密钥请填在下面一栏，不要填进 APP ID。")
        if os.environ.get("BAIDU_APPID") or os.environ.get("BAIDU_KEY"):
            raise ValueError("当前进程用环境变量提供了凭据，网页里的修改不会生效。请改环境变量或取消 BAIDU_APPID / BAIDU_KEY。")
        save_credentials(new_appid, new_key)
        status = credential_status()
        self.send_json(200, {"ok": True, **status})

    def handle_upload(self) -> None:
        filename = clean_filename(self.headers.get("X-Filename") or "image.png")
        data = self.read_body(MAX_UPLOAD)
        if not data:
            raise ValueError("文件是空的")
        ext = sniff_ext(data, filename)
        parsed = prompt_meta.extract_bytes(data, filename)
        item_id = uuid.uuid4().hex
        IMAGES.mkdir(parents=True, exist_ok=True)
        (IMAGES / f"{item_id}.{ext}").write_bytes(data)
        item = decorate_new_item(
            {
                "id": item_id,
                "name": filename,
                "created": time.time(),
                "image": f"/media/{item_id}.{ext}",
                "sample": False,
                "positive": parsed.get("positive") or "",
                "negative": parsed.get("negative") or "",
                "source": parsed.get("source") or "",
                "meta": parsed.get("meta") or {},
                "warning": parsed.get("warning") or "",
            }
        )
        with GALLERY_LOCK:
            gallery = load_gallery()
            gallery["items"].append(item)
            save_gallery(gallery)
        self.send_json(200, {"ok": True, "item": public_item(item)})

    def handle_patch(self, item_id: str) -> None:
        if not ID_RE.match(item_id):
            raise ValueError("编号无效")
        body = self.read_json()
        with GALLERY_LOCK:
            gallery = load_gallery()
            item = find_item(gallery, item_id)
            if item is None:
                self.send_json(404, {"ok": False, "error": "找不到这张图"})
                return
            for field in ("positive", "negative", "translation", "negativeTranslation"):
                if field in body:
                    item[field] = str(body.get(field) or "")[: prompt_meta.MAX_TEXT]
            if "translation" in body:
                item["translationFrom"] = "manual" if item.get("translation") else ""
            if "negativeTranslation" in body:
                item["negativeFrom"] = "manual" if item.get("negativeTranslation") else ""
            save_gallery(gallery)
            self.send_json(200, {"ok": True, "item": public_item(item)})

    def handle_translate(self, item_id: str) -> None:
        if not ID_RE.match(item_id):
            raise ValueError("编号无效")
        body = self.read_json(optional=True)
        force = bool(body.get("force"))
        with GALLERY_LOCK:
            gallery = load_gallery()
            item = find_item(gallery, item_id)
            if item is None:
                self.send_json(404, {"ok": False, "error": "找不到这张图"})
                return
            snapshot = {
                "positive": item.get("positive") or "",
                "negative": item.get("negative") or "",
                "translation": item.get("translation") or "",
                "negativeTranslation": item.get("negativeTranslation") or "",
                "translationFrom": item.get("translationFrom") or "",
                "negativeFrom": item.get("negativeFrom") or "",
            }
        if not snapshot["positive"].strip() and not snapshot["negative"].strip():
            raise ValueError("没有可翻译的提示词")
        positive, positive_from, positive_error = translate_field(
            snapshot["translation"],
            snapshot["positive"],
            snapshot["translationFrom"],
            force,
        )
        negative, negative_from, negative_error = ("", "", "")
        if not positive_error:
            negative, negative_from, negative_error = translate_field(
                snapshot["negativeTranslation"],
                snapshot["negative"],
                snapshot["negativeFrom"],
                force,
            )
        warning = positive_error or negative_error
        if positive_error and not positive:
            raise TranslateError(positive_error)
        with GALLERY_LOCK:
            gallery = load_gallery()
            item = find_item(gallery, item_id)
            if item is None:
                self.send_json(404, {"ok": False, "error": "找不到这张图"})
                return
            if force or item.get("translationFrom") != "manual":
                if force or not item.get("translation"):
                    item["translation"] = positive
                    item["translationFrom"] = positive_from
            if snapshot["negative"] and (force or item.get("negativeFrom") != "manual"):
                if force or not item.get("negativeTranslation"):
                    item["negativeTranslation"] = negative
                    item["negativeFrom"] = negative_from
            save_gallery(gallery)
            payload = {"ok": True, "item": public_item(item)}
            if warning:
                payload["warning"] = warning
            self.send_json(200, payload)

    def handle_delete(self, item_id: str) -> None:
        if not ID_RE.match(item_id):
            self.send_json(400, {"ok": False, "error": "编号无效"})
            return
        with GALLERY_LOCK:
            gallery = load_gallery()
            kept = []
            removed = None
            for item in gallery["items"]:
                if item.get("id") == item_id and removed is None:
                    removed = item
                else:
                    kept.append(item)
            if removed is None:
                self.send_json(404, {"ok": False, "error": "找不到这张图"})
                return
            gallery["items"] = kept
            save_gallery(gallery)
        image = removed.get("image") or ""
        if image.startswith("/media/"):
            name = image.rsplit("/", 1)[-1]
            if MEDIA_RE.match(name):
                target = (IMAGES / name).resolve()
                if target.is_file() and target.parent == IMAGES.resolve():
                    target.unlink()
        self.send_json(200, {"ok": True})

    def handle_restore(self) -> None:
        added = 0
        with GALLERY_LOCK:
            gallery = load_gallery()
            existing = {item.get("id") for item in gallery["items"]}
            for item in manifest_items():
                if item["id"] not in existing:
                    gallery["items"].append(item)
                    added += 1
            save_gallery(gallery)
        self.send_json(200, {"ok": True, "added": added})

    def handle_lora_create(self) -> None:
        body = self.read_json()
        name = str(body.get("name") or "").strip()
        base = str(body.get("base") or "").strip()
        if not name:
            raise ValueError("请填写名称")
        if not base:
            raise ValueError("请填写底模")
        item = {
            "id": uuid.uuid4().hex,
            "name": name[:120],
            "base": base[:80],
            "summary": str(body.get("summary") or "")[:MAX_LORA_SUMMARY],
            "url": clean_http_url(str(body.get("url") or "")),
            "images": [],
            "sample": False,
            "created": time.time(),
        }
        with LORA_LOCK:
            data = load_loras()
            data["items"].append(item)
            save_loras(data)
        self.send_json(200, {"ok": True, "item": public_lora(item)})

    def handle_lora_image(self, item_id: str) -> None:
        if not ID_RE.match(item_id):
            raise ValueError("编号无效")
        filename = clean_filename(self.headers.get("X-Filename") or "image.png")
        payload = self.read_body(MAX_UPLOAD)
        if not payload:
            raise ValueError("文件是空的")
        ext = sniff_ext(payload, filename)
        image_id = uuid.uuid4().hex
        LORA_IMAGES.mkdir(parents=True, exist_ok=True)
        (LORA_IMAGES / f"{image_id}.{ext}").write_bytes(payload)
        image_url = f"/lora-media/{image_id}.{ext}"
        with LORA_LOCK:
            data = load_loras()
            item = find_lora(data, item_id)
            if item is None:
                target = LORA_IMAGES / f"{image_id}.{ext}"
                if target.is_file():
                    target.unlink()
                self.send_json(404, {"ok": False, "error": "找不到这个 LoRA"})
                return
            images = [image for image in item.get("images") or [] if isinstance(image, str)]
            if len(images) >= MAX_LORA_IMAGES:
                target = LORA_IMAGES / f"{image_id}.{ext}"
                if target.is_file():
                    target.unlink()
                raise ValueError(f"每个 LoRA 最多 {MAX_LORA_IMAGES} 张样例图")
            images.append(image_url)
            item["images"] = images
            save_loras(data)
            self.send_json(200, {"ok": True, "item": public_lora(item)})

    def handle_lora_delete(self, item_id: str) -> None:
        if not ID_RE.match(item_id):
            self.send_json(400, {"ok": False, "error": "编号无效"})
            return
        with LORA_LOCK:
            data = load_loras()
            kept = []
            removed = None
            for item in data["items"]:
                if item.get("id") == item_id and removed is None:
                    removed = item
                else:
                    kept.append(item)
            if removed is None:
                self.send_json(404, {"ok": False, "error": "找不到这个 LoRA"})
                return
            data["items"] = kept
            save_loras(data)
        for image in removed.get("images") or []:
            if not isinstance(image, str) or not image.startswith("/lora-media/"):
                continue
            name = lora_media_name(image)
            if not name:
                continue
            target = (LORA_IMAGES / name).resolve()
            if target.is_file() and target.parent == LORA_IMAGES.resolve():
                target.unlink()
        self.send_json(200, {"ok": True})

    def handle_lora_restore(self) -> None:
        added = 0
        with LORA_LOCK:
            data = load_loras()
            existing = {item.get("id") for item in data["items"]}
            for item in lora_manifest_items():
                if item["id"] not in existing:
                    data["items"].append(item)
                    added += 1
            save_loras(data)
        self.send_json(200, {"ok": True, "added": added})

    def serve_lora_media(self, name: str) -> None:
        if not MEDIA_RE.match(name):
            self.send_error(404)
            return
        target = (LORA_IMAGES / name).resolve()
        if target.parent != LORA_IMAGES.resolve() or not target.is_file():
            self.send_error(404)
            return
        self.serve_file(target, cache=False)

    def serve_media(self, name: str) -> None:
        if not MEDIA_RE.match(name):
            self.send_error(404)
            return
        target = (IMAGES / name).resolve()
        if target.parent != IMAGES.resolve() or not target.is_file():
            self.send_error(404)
            return
        self.serve_file(target, cache=False)

    def serve_static(self, path: str) -> None:
        if path == "/":
            path = "/index.html"
        relative = path.lstrip("/")
        if not relative or ".." in relative.split("/"):
            self.send_error(404)
            return
        target = (PUBLIC / relative).resolve()
        try:
            target.relative_to(PUBLIC.resolve())
        except ValueError:
            self.send_error(404)
            return
        if not target.is_file():
            self.send_error(404)
            return
        self.serve_file(target, cache=target.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".svg"))

    def serve_file(self, target: Path, cache: bool) -> None:
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
        }.get(target.suffix.lower(), "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400" if cache else "no-cache")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="AI 图片提示词图库")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    IMAGES.mkdir(parents=True, exist_ok=True)
    LORA_IMAGES.mkdir(parents=True, exist_ok=True)
    try:
        with GALLERY_LOCK:
            load_gallery()
        with LORA_LOCK:
            load_loras()
    except (RuntimeError, json.JSONDecodeError) as exc:
        raise SystemExit(str(exc))
    status = credential_status()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    if args.host == "0.0.0.0":
        url = f"http://127.0.0.1:{args.port}/"
    print(f"提示词图库已启动：{url}", flush=True)
    if status["hasKey"] and not status["hasAppId"]:
        print("翻译尚未就绪：已读到密钥，还缺少百度翻译 APP ID。可在网页右上角「设置」里补上。", flush=True)
    elif not status["hasKey"] or not status["hasAppId"]:
        print("翻译尚未就绪：请在 百度翻译api.txt 或网页设置里填写 APP ID 和密钥。", flush=True)
    else:
        print("百度翻译凭据已就绪。", flush=True)
    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
