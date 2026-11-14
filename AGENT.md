# AGENT.md

给后续接手这个仓库的 AI。先读本文件，再改代码。部署步骤在 `部署交接.md`，不要把两份文档写成重复的操作手册。

## 这是什么

本地图库：看 AI 图片、读出图片里的提示词、用百度翻译成中文，并允许用户改译文。

页面是静态 HTML / CSS / JS，没有构建步骤。旁边有一个只依赖 Python 标准库的小服务，负责读元数据、代理翻译、把图库写到磁盘。不要引入 npm、打包工具或第三方 Python 包，除非用户明确要求。生成示例图的 `scripts/build_samples.py` 才会用到 Pillow，服务器运行不需要它。

不要用 `file://` 打开 `public/index.html`。浏览器直接打开文件时无法调用接口。入口是 `start.bat`（Windows）或 `python server.py`（默认 `http://127.0.0.1:8765/`）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `server.py` | HTTP 服务。按 `__file__` 定位项目根，不依赖当前工作目录 |
| `prompt_meta.py` | 从 PNG / JPEG / WebP 字节里提取提示词。上传和示例图生成都走这里 |
| `public/` | 唯一对浏览器开放的目录：`index.html`、`css/app.js` 对应的 `js/app.js`、`css/app.css`、`samples/` |
| `public/samples/` | 6 张预生成 JPEG 和 `manifest.json`。首次没有 `data/gallery.json` 时用它做种子 |
| `data/gallery.json` | 图库正文。提示词、译文、模型信息都在这里。运行时生成，已在 `.gitignore` |
| `data/images/` | 用户上传的原图，文件名是 32 位 hex 加扩展名 |
| `百度翻译api.txt` | 翻译凭据。只放在项目根目录。`public/` 不会提供它 |
| `start.bat` / `start.sh` | 启动脚本 |
| `scripts/smoke_test.py` | 服务已启动时的接口冒烟测试 |
| `scripts/build_samples.py` | 从本机测试图重建 `public/samples/`。默认源目录是 `D:\AI\.AI生图\带工作流的图片` |
| `部署交接.md` | 给有 SSH 的部署代理：端口、Nginx、systemd、百度 IP 白名单 |

改 Python 后必须重启服务，进程不会自动重载。只改 `public/` 里的文件，刷新浏览器即可。

## 数据怎么存

没有数据库，也没有浏览器本地存储。一条图就是 `data/gallery.json` 里 `items` 的一个对象：

- `positive` / `negative`：从图片元数据读出的原文。上传之后页面读写的是这份文字，不再每次解析图片。
- `translation` / `negativeTranslation`：中文译文，用户可改。
- `translationFrom` / `negativeFrom`：`baidu`（接口译文）、`copy`（原文主要是中文，直接抄入）、`manual`（用户改过）。`manual` 时，非强制翻译不能覆盖。
- `meta`：模型、LoRA、种子、步数、CFG、采样器、宽高。
- `image`：`/samples/01.jpg` 或 `/media/<id>.png`。
- `sample`：示例图为 true。删除示例只删记录，不删 `public/samples/` 里的文件。删除上传会同时删 `data/images/` 里的原图。

写 `gallery.json` 要用临时文件再替换，沿用 `server.py` 里的 `save_gallery`。不要手改坏 JSON。文件损坏时服务会拒绝启动，不会自动清空。

示例图的 JPEG 已经去掉了原始 PNG 元数据，提示词只存在 JSON 里。用户上传的原图仍保留元数据，但展示以 JSON 为准。

## 提示词怎么读

逻辑全在 `prompt_meta.py` 的 `extract_bytes`。不要在前端再写一套解析。

优先顺序：WebUI 的 `parameters`、ComfyUI 的 `prompt` JSON、NovelAI / Invoke 的注释或 JSON，最后才是 `workflow`。

ComfyUI 要顺着采样器的 `positive` / `negative` 连线走，不要在整张工作流里挑最长的一段文字。文本可能在这些字段上：`positive`、`text`、`prompt`、`value`、`string`。`PrimitiveStringMultiline` 的正文在 `value`。`ConditioningZeroOut` 表示没有反向提示词。LoRA 加载器上的 `<lora:...>` 只放进 `meta.loras`，不要当成提示词。

工作流 UI 里的控件值可能是过期示例。某个输入的 `link` 不是 null 时，那个控件里的文字不是这张图真正使用的提示词。批量导入曾经因此把同一段示例写进所有图片。修这类问题时，用多张不同的图断言提示词互不相同，并再跑一遍 `D:\AI\.AI生图\带工作流的图片` 里的 PNG，避免把原来的 WeiLin / CLIP 图读空。

## 翻译

百度通用翻译 API，签名是 `MD5(appid + q + salt + 密钥)`，`q` 参与签名时不要做 URL 编码。实现在 `server.py` 的 `baidu_translate`。

凭据格式写在 `百度翻译api.txt` 顶部注释里。环境变量 `BAIDU_APPID`、`BAIDU_KEY` 会覆盖文件。当前仓库里的文件只有密钥，APP ID 由用户在网页「设置」里补。不要把密钥写进前端、日志、`public/` 或这份文档。

原文里汉字占字母的比例达到 0.45 时，译文直接抄原文，`translationFrom` 为 `copy`，不请求百度。长文本按大约 4500 字节分段，请求间隔约 1 秒。改译文的接口如果带 `force: true`，会覆盖用户改过的内容；普通翻译不要这样做。

## 接口

页面通过同源 `fetch` 调用。跨站 `Origin` 会被拒绝。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 不需要口令。返回凭据是否齐全、是否启用了 `ACCESS_TOKEN` |
| POST | `/api/login` | `{"token":"..."}` |
| GET | `/api/gallery` | 图库列表，按 `created` 倒序 |
| POST | `/api/upload` | 原始图片作 body，`X-Filename` 是 URL 编码后的文件名。上限 40MB，只收 PNG、JPEG、WebP |
| PATCH | `/api/items/<id>` | 保存 `positive`、`negative`、`translation`、`negativeTranslation` |
| POST | `/api/items/<id>/translate` | 可带 `{"force": true}` |
| DELETE | `/api/items/<id>` | 删除记录；上传图同时删原图 |
| POST | `/api/settings` | 补 APP ID 或密钥。空字符串表示保持原值。APP ID 必须是纯数字 |
| POST | `/api/samples/restore` | 把缺失的示例加回来，不覆盖已有记录 |
| GET | `/media/<文件名>` | 用户原图 |
| GET | `/samples/...` | 示例图 |

设置了 `ACCESS_TOKEN` 之后，除 `/api/health` 和静态页面外，上述接口和 `/media/` 都要登录。`public/samples/` 仍是静态文件。

## 改动时不要破坏的事

- `start.bat` 不要加入 `chcp 65001`。Windows 的 cmd 会在切换代码页后把后续命令读乱，双击窗口会一闪退出。脚本保持 ASCII。需要 UTF-8 输出时用已经写好的 `PYTHONUTF8` 和 `PYTHONIOENCODING`。
- 不要把 `百度翻译api.txt`、`server.py`、`data/` 放进可被静态访问的目录。
- 前端插入提示词、文件名、译文时继续走 `textContent` 或先转义。图片地址只允许 `/samples/` 和 `/media/` 下的安全文件名。
- 上传是逐张 `await` 的。不要改成不读完 body 的连接复用，否则下一张图会吃到上一张的数据。
- 界面要同时能看图、原文和译文，并在窄屏下改成上下排列。原文和译文都要能改，译文是主要编辑区。

## 怎样确认没改坏

服务启动后：

```text
python scripts/smoke_test.py
```

它会检查健康接口、凭据文件不能被下载、示例图、上传、保存译文、没有 APP ID 时翻译失败、以及一张真实 ComfyUI PNG。冒烟测试会删除自己上传的图。

再手动看这三件事：画廊里不同图片的提示词不同；点开一张图能同时看到图片和两边文字；改译文后刷新还在。Python 改动要先重启再测。
