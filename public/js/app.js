const state = {
  items: [],
  query: "",
  filter: "all",
  activeId: null,
  health: null,
  editingPositive: false,
  saveTimer: 0,
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function safeSrc(url) {
  return /^\/(samples|media)\/[A-Za-z0-9._-]+$/.test(url || "") ? url : "";
}

function pretty(text) {
  const value = (text || "").trim();
  const newlines = (value.match(/\n/g) || []).length;
  if (newlines >= 2) return value;
  if ((value.match(/,\s/g) || []).length >= 4) return value.replace(/,\s+/g, ",\n");
  return value;
}

function excerpt(text) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > 86 ? flat.slice(0, 86) + "…" : flat;
}

function hasTranslation(item) {
  return Boolean((item.translation || "").trim() || (item.negativeTranslation || "").trim());
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options });
  } catch (_error) {
    throw new Error("服务没有响应。本地请运行 start.bat；如果已经部署，请检查 Python 服务是否在运行。");
  }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("json") ? await response.json() : null;
  if (response.status === 401) {
    showGate();
    throw new Error((data && data.error) || "需要访问口令");
  }
  if (!response.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `请求失败（${response.status}）`);
  }
  return data;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

function visibleItems() {
  const query = state.query.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.filter === "todo" && hasTranslation(item)) return false;
    if (state.filter === "done" && !hasTranslation(item)) return false;
    if (!query) return true;
    const haystack = [item.name, item.positive, item.negative, item.translation, item.negativeTranslation, item.source]
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function activeItem() {
  return state.items.find((item) => item.id === state.activeId) || null;
}

function render() {
  const items = visibleItems();
  const total = state.items.length;
  const done = state.items.filter(hasTranslation).length;
  $("count").textContent = total ? `${total} 张 · ${done} 张已有译文` : "";
  if (!items.length) {
    $("grid").innerHTML = total
      ? `<div class="empty"><h2>没有匹配的图片</h2><p>换个词，或者切回「全部」。</p></div>`
      : `<div class="empty"><h2>图库还是空的</h2><p>添加 PNG、JPEG 或 WebP。ComfyUI 和 WebUI 写在图片里的提示词会被读出来。</p></div>`;
    return;
  }
  $("grid").innerHTML = items.map((item) => {
    const translated = hasTranslation(item);
    const text = translated ? item.translation || item.negativeTranslation : item.positive || item.warning || "还没有读到提示词";
    const pill = item._busy ? "翻译中" : translated ? "已有译文" : "未翻译";
    return `<article class="card" data-id="${esc(item.id)}" tabindex="0" role="button">
      <div class="thumb">
        <img src="${esc(safeSrc(item.image))}" alt="" loading="lazy">
        <span class="pill${item._busy ? " busy" : ""}">${pill}</span>
      </div>
      <div class="body">
        <p class="excerpt${translated ? " zh" : ""}">${esc(excerpt(text))}</p>
      </div>
    </article>`;
  }).join("");
}

function noteFor(item) {
  if (item.warning && !item.positive) return item.warning;
  if (item.translationFrom === "copy") return "原文主要是中文，译文先按原文填好了，可以直接改。";
  if (item.translationFrom === "manual") return "这是改过的译文。点「翻译」会覆盖它。";
  if (item.translationFrom === "baidu") return "";
  if (!item.positive) return "没有读到提示词。可以在「编辑原文」里自己贴上，再点翻译。";
  return "还没有译文。点「翻译」会调用百度翻译。";
}

function metaChips(item) {
  const meta = item.meta || {};
  const chips = [];
  if (item.source) chips.push(item.source);
  if (meta.model) chips.push(meta.model);
  if (meta.width && meta.height) chips.push(`${meta.width} × ${meta.height}`);
  if (meta.steps != null && meta.steps !== "") chips.push(`${meta.steps} 步`);
  if (meta.cfg != null && meta.cfg !== "") chips.push(`CFG ${meta.cfg}`);
  if (meta.sampler) chips.push(meta.sampler);
  if (meta.scheduler) chips.push(meta.scheduler);
  if (meta.seed) chips.push(`种子 ${meta.seed}`);
  (meta.loras || []).slice(0, 6).forEach((name) => chips.push(name));
  $("reader-meta").innerHTML = chips.map((chip) => `<span class="meta-chip">${esc(chip)}</span>`).join("");
}

function setIfIdle(node, value) {
  if (document.activeElement === node) return;
  if (node.value !== value) node.value = value;
}

function fillReader() {
  const item = activeItem();
  if (!item || !$("reader").open) return;
  syncFrame(item);
  metaChips(item);
  const warning = $("reader-warning");
  warning.hidden = !item.warning;
  warning.textContent = item.warning || "";
  $("positive-view").textContent = pretty(item.positive) || "（空）";
  if (!state.editingPositive) setIfIdle($("positive-edit"), item.positive || "");
  const negativeBlock = $("negative-block");
  const showNegative = Boolean((item.negative || "").trim() || (item.negativeTranslation || "").trim());
  negativeBlock.hidden = !showNegative;
  if (showNegative) {
    $("negative-view").textContent = pretty(item.negative) || "（空）";
    setIfIdle($("negative-translation"), item.negativeTranslation || "");
  }
  setIfIdle($("translation"), item.translation || "");
  const note = noteFor(item);
  $("reader-note").hidden = !note;
  $("reader-note").textContent = note;
  $("retranslate").textContent = item._busy ? "翻译中…" : (hasTranslation(item) ? "重新翻译" : "翻译");
  $("retranslate").disabled = Boolean(item._busy);
}

function syncFrame(item) {
  const img = $("reader-img");
  const reader = $("reader");
  const apply = () => {
    if (activeItem() !== item) return;
    const meta = item.meta || {};
    const width = img.naturalWidth || Number(meta.width) || 0;
    const height = img.naturalHeight || Number(meta.height) || 0;
    reader.classList.toggle("is-land", width > 0 && height > 0 && width > height);
  };
  const next = safeSrc(item.image);
  if (img.getAttribute("src") !== next) {
    img.onload = apply;
    img.onerror = apply;
    img.src = next;
  }
  if (img.complete) apply();
  else {
    const meta = item.meta || {};
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    if (width && height) reader.classList.toggle("is-land", width > height);
  }
}

function openReader(id) {
  state.activeId = id;
  state.editingPositive = false;
  $("positive-view").hidden = false;
  $("positive-edit").hidden = true;
  $("edit-positive").textContent = "编辑原文";
  const opened = activeItem();
  $("negative-block").open = Boolean(opened && ((opened.negative || "").trim() || (opened.negativeTranslation || "").trim()));
  $("reader").showModal();
  fillReader();
  location.hash = "item=" + encodeURIComponent(id);
}

function closeReader() {
  if ($("reader").open) $("reader").close();
}

function step(delta) {
  const items = visibleItems();
  const index = items.findIndex((item) => item.id === state.activeId);
  if (index < 0) return;
  const next = items[(index + delta + items.length) % items.length];
  if (next) openReader(next.id);
}

function upsert(item, extra = {}) {
  const index = state.items.findIndex((entry) => entry.id === item.id);
  const prev = index >= 0 ? state.items[index] : null;
  const next = {
    ...item,
    _busy: extra.busy != null ? extra.busy : Boolean(prev && prev._busy),
    _dirty: extra.dirty != null ? extra.dirty : Boolean(prev && prev._dirty),
  };
  if (next._dirty && prev) {
    next.translation = prev.translation;
    next.negativeTranslation = prev.negativeTranslation;
    next.translationFrom = prev.translationFrom;
    next.negativeFrom = prev.negativeFrom;
  }
  if (index >= 0) state.items[index] = next;
  else state.items.unshift(next);
  return next;
}

async function loadGallery() {
  const data = await api("/api/gallery");
  state.items = data.items.map((item) => ({ ...item, _busy: false, _dirty: false }));
  render();
  const hash = location.hash.match(/^#item=([^&]+)/);
  if (hash) {
    const id = decodeURIComponent(hash[1]);
    if (state.items.some((item) => item.id === id)) openReader(id);
  }
}

function showBanner() {
  const health = state.health;
  const banner = $("banner");
  if (!health) {
    banner.hidden = true;
    return;
  }
  if (!health.hasAppId || !health.hasKey) {
    const missing = !health.hasAppId && !health.hasKey
      ? "还没有百度翻译的 APP ID 和密钥。"
      : !health.hasAppId
        ? "密钥已经读到了，还差百度翻译 APP ID。"
        : "还没有百度翻译密钥。";
    banner.innerHTML = `<span>${esc(missing)}没有它也能看图和改译文，只是不能自动翻译。</span><button type="button" class="btn ghost" id="banner-settings">去设置</button>`;
    banner.hidden = false;
    $("banner-settings").addEventListener("click", openSettings);
    return;
  }
  banner.hidden = true;
}

function showGate() {
  if (!$("gate").open) $("gate").showModal();
}

async function boot() {
  try {
    state.health = await api("/api/health");
  } catch (error) {
    $("grid").innerHTML = `<div class="empty"><h2>没有连上服务</h2><p>${esc(error.message)}</p></div>`;
    return;
  }
  if (state.health.needsAuth) {
    try {
      await loadGallery();
    } catch (error) {
      if (!$("gate").open) showGate();
      return;
    }
  } else {
    await loadGallery();
  }
  showBanner();
}

async function uploadOne(file) {
  const data = await api("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  return upsert(data.item);
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((file) => /image\/(png|jpeg|webp)/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name));
  if (!files.length) {
    toast("请添加 PNG、JPEG 或 WebP");
    return;
  }
  const pending = [];
  for (const file of files) {
    try {
      const item = await uploadOne(file);
      render();
      if (item.positive && !item.translation) pending.push(item.id);
      else if (item.warning) toast(item.warning);
    } catch (error) {
      toast(file.name + "：" + error.message);
    }
  }
  for (const id of pending) {
    await translateOne(id, false);
  }
}

async function translateOne(id, force) {
  const current = state.items.find((item) => item.id === id);
  if (!current) return;
  if (force && !confirm("重新翻译会覆盖当前译文。继续？")) return;
  current._busy = true;
  render();
  fillReader();
  try {
    const data = await api(`/api/items/${encodeURIComponent(id)}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: Boolean(force) }),
    });
    upsert(data.item, { busy: false });
    if (data.warning) toast(data.warning);
  } catch (error) {
    current._busy = false;
    toast(error.message);
  }
  render();
  fillReader();
}

async function translateMissing() {
  const ids = state.items.filter((item) => item.positive && !hasTranslation(item)).map((item) => item.id);
  if (!ids.length) {
    toast("没有待翻译的图片");
    return;
  }
  for (const id of ids) await translateOne(id, false);
}

function scheduleSave() {
  const item = activeItem();
  if (!item) return;
  item._dirty = true;
  item.translation = $("translation").value;
  item.negativeTranslation = $("negative-block").hidden ? item.negativeTranslation : $("negative-translation").value;
  $("save-state").textContent = "正在输入…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveTranslation(), 700);
}

async function saveTranslation() {
  const item = activeItem();
  if (!item || !item._dirty) return;
  const id = item.id;
  $("save-state").textContent = "保存中…";
  try {
    const data = await api(`/api/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translation: $("translation").value,
        negativeTranslation: $("negative-block").hidden ? item.negativeTranslation || "" : $("negative-translation").value,
      }),
    });
    const latest = state.items.find((entry) => entry.id === id);
    if (latest) latest._dirty = false;
    upsert(data.item, { dirty: false, busy: latest ? latest._busy : false });
    $("save-state").textContent = "已保存";
    render();
    fillReader();
  } catch (error) {
    $("save-state").textContent = "没保存上";
    toast(error.message);
  }
}

async function savePositive() {
  const item = activeItem();
  if (!item) return;
  const value = $("positive-edit").value;
  if (value === (item.positive || "")) return;
  const data = await api(`/api/items/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positive: value }),
  });
  upsert(data.item);
  render();
  fillReader();
  $("save-state").textContent = "原文已保存";
}

async function removeActive() {
  const item = activeItem();
  if (!item) return;
  const message = (item.image || "").startsWith("/media/")
    ? `删除「${item.name}」？原图和译文都会从这台机器的图库里去掉。`
    : `从画廊移除「${item.name}」？这条记录会删掉，示例图文件还在。`;
  if (!confirm(message)) return;
  await api(`/api/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  state.items = state.items.filter((entry) => entry.id !== item.id);
  closeReader();
  render();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast("已复制");
  } catch (_error) {
    toast("复制失败，请手动选择文本");
  }
}

function openSettings() {
  $("settings-msg").textContent = "";
  $("appid").value = "";
  $("appkey").value = "";
  const health = state.health || {};
  $("appkey").placeholder = health.hasKey ? "已保存密钥，留空则不修改" : "百度翻译密钥";
  if (!$("settings").open) $("settings").showModal();
}

function bind() {
  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    render();
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((node) => node.classList.toggle("is-on", node === button));
      render();
    });
  });
  $("file").addEventListener("change", (event) => {
    handleFiles(event.target.files);
    event.target.value = "";
  });
  $("translate-all").addEventListener("click", async () => {
    $("translate-all").disabled = true;
    try {
      await translateMissing();
    } catch (error) {
      toast(error.message);
    } finally {
      $("translate-all").disabled = false;
    }
  });
  $("settings-btn").addEventListener("click", openSettings);
  $("grid").addEventListener("click", (event) => {
    const card = event.target.closest(".card");
    if (card) openReader(card.dataset.id);
  });
  $("grid").addEventListener("keydown", (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openReader(card.dataset.id);
    }
  });
  $("reader-close").addEventListener("click", closeReader);
  $("reader").addEventListener("close", () => {
    const item = activeItem();
    if (item && item._dirty) {
      clearTimeout(state.saveTimer);
      saveTranslation();
    }
    if (item && state.editingPositive && $("positive-edit").value !== (item.positive || "")) {
      const id = item.id;
      const value = $("positive-edit").value;
      api(`/api/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positive: value }),
      }).then((data) => {
        upsert(data.item);
        render();
      }).catch((error) => toast(error.message));
    }
    state.activeId = null;
    state.editingPositive = false;
    if (location.hash.startsWith("#item=")) history.replaceState(null, "", location.pathname + location.search);
  });
  $("prev-item").addEventListener("click", () => step(-1));
  $("next-item").addEventListener("click", () => step(1));
  $("translation").addEventListener("input", scheduleSave);
  $("negative-translation").addEventListener("input", scheduleSave);
  $("edit-positive").addEventListener("click", async () => {
    state.editingPositive = !state.editingPositive;
    $("positive-view").hidden = state.editingPositive;
    $("positive-edit").hidden = !state.editingPositive;
    $("edit-positive").textContent = state.editingPositive ? "完成" : "编辑原文";
    if (state.editingPositive) {
      $("positive-edit").value = (activeItem() || {}).positive || "";
      $("positive-edit").focus();
    } else {
      try {
        await savePositive();
      } catch (error) {
        toast(error.message);
      }
    }
  });
  $("retranslate").addEventListener("click", () => {
    const item = activeItem();
    if (item) translateOne(item.id, hasTranslation(item)).catch((error) => toast(error.message));
  });
  $("copy-positive").addEventListener("click", () => copyText((activeItem() || {}).positive || ""));
  $("copy-zh").addEventListener("click", () => copyText($("translation").value));
  $("copy-negative-zh").addEventListener("click", () => copyText($("negative-translation").value));
  $("delete-item").addEventListener("click", () => {
    removeActive().catch((error) => toast(error.message));
  });
  $("settings-close").addEventListener("click", () => $("settings").close());
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("settings-msg").textContent = "保存中…";
    try {
      state.health = {
        ...state.health,
        ...(await api("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appid: $("appid").value.trim(), key: $("appkey").value.trim() }),
        })),
      };
      $("settings-msg").textContent = "已保存";
      showBanner();
    } catch (error) {
      $("settings-msg").textContent = error.message;
    }
  });
  $("restore-samples").addEventListener("click", async () => {
    try {
      const data = await api("/api/samples/restore", { method: "POST" });
      await loadGallery();
      toast(data.added ? `已恢复 ${data.added} 张示例` : "示例图都在");
    } catch (error) {
      toast(error.message);
    }
  });
  $("gate-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("gate-msg").textContent = "";
    try {
      await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: $("gate-token").value }),
      });
      $("gate").close();
      await loadGallery();
      showBanner();
    } catch (error) {
      $("gate-msg").textContent = error.message;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!$("reader").open) return;
    if (event.target.matches("textarea, input")) return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });
  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    if (![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
    dragDepth += 1;
    $("drop").hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("drop").hidden = true;
  });
  window.addEventListener("drop", (event) => {
    dragDepth = 0;
    $("drop").hidden = true;
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      handleFiles(event.dataTransfer.files);
    }
  });
}

bind();
boot().catch((error) => {
  $("grid").innerHTML = `<div class="empty"><h2>没有打开图库</h2><p>${esc(error.message)}</p></div>`;
});
