const state = {
  items: [],
  query: "",
  filter: "all",
  activeId: null,
  health: null,
  editingPositive: false,
  editingTranslation: false,
  mode: "both",
  zoom: 1,
  panX: 0,
  panY: 0,
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
  Site.toast(message);
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
  $("positive-view").textContent = item.positive || "（空）";
  if (!state.editingPositive) setIfIdle($("positive-edit"), item.positive || "");
  const showNegative = Boolean((item.negative || "").trim() || (item.negativeTranslation || "").trim());
  $("negative-block").hidden = !(item.negative || "").trim();
  $("negative-zh-block").hidden = !showNegative;
  if ((item.negative || "").trim()) $("negative-view").textContent = item.negative;
  $("negative-zh-view").textContent = item.negativeTranslation || "（空）";
  if (!state.editingTranslation) setIfIdle($("negative-translation"), item.negativeTranslation || "");
  $("translation-view").textContent = item.translation || "（还没有译文）";
  if (!state.editingTranslation) setIfIdle($("translation"), item.translation || "");
  const note = noteFor(item);
  $("reader-note").hidden = !note;
  $("reader-note").textContent = note;
  applyEditChrome();
  $("retranslate").textContent = item._busy ? "翻译中…" : (hasTranslation(item) ? "重新翻译" : "翻译");
  $("retranslate").disabled = Boolean(item._busy);
}

function applyEditChrome() {
  const editingEn = state.editingPositive;
  const editingZh = state.editingTranslation;
  $("positive-view").hidden = editingEn;
  $("positive-edit").hidden = !editingEn;
  $("edit-positive").hidden = editingEn;
  $("copy-positive").hidden = editingEn;
  $("save-positive").hidden = !editingEn;
  $("cancel-positive").hidden = !editingEn;
  $("translation-view").hidden = editingZh;
  $("translation").hidden = !editingZh;
  $("edit-translation").hidden = editingZh;
  $("copy-zh").hidden = editingZh;
  $("save-translation").hidden = !editingZh;
  $("cancel-translation").hidden = !editingZh;
  $("negative-zh-view").hidden = editingZh;
  $("negative-translation").hidden = !editingZh || $("negative-zh-block").hidden;
}

function promptDirty() {
  const item = activeItem();
  if (!item) return false;
  if (state.editingPositive && $("positive-edit").value !== (item.positive || "")) return true;
  if (!state.editingTranslation) return false;
  if ($("translation").value !== (item.translation || "")) return true;
  return !$("negative-zh-block").hidden && $("negative-translation").value !== (item.negativeTranslation || "");
}

function confirmLeave() {
  if (!promptDirty()) return true;
  return confirm("有未保存的修改，离开后会丢掉。继续？");
}

function applyZoom() {
  const zoom = state.zoom || 1;
  $("reader-img").style.transform = `translate(${state.panX || 0}px, ${state.panY || 0}px) scale(${zoom})`;
  $("frame-zoom").textContent = `${Math.round(zoom * 100)}%`;
  $("viewport").classList.toggle("can-pan", zoom > 1);
}

function resetZoom() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyZoom();
}

function setZoom(value) {
  state.zoom = Math.min(4, Math.max(1, Math.round(value * 100) / 100));
  if (state.zoom === 1) {
    state.panX = 0;
    state.panY = 0;
  }
  applyZoom();
}

function preloadAround(item) {
  const items = visibleItems();
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0 || items.length < 2) return;
  [index - 1, index + 1].forEach((slot) => {
    const neighbor = items[(slot + items.length) % items.length];
    const src = neighbor && safeSrc(neighbor.image);
    if (!src || src === safeSrc(item.image)) return;
    const probe = new Image();
    probe.src = src;
  });
}

function syncFrame(item) {
  const img = $("reader-img");
  const next = safeSrc(item.image);
  const paint = () => {
    if (activeItem() !== item) return;
    const meta = item.meta || {};
    const width = img.naturalWidth || Number(meta.width) || 0;
    const height = img.naturalHeight || Number(meta.height) || 0;
    $("frame-res").textContent = width && height ? `${width} × ${height}` : "";
    $("stage-blur").style.backgroundImage = next ? `url("${next}")` : "";
  };
  const items = visibleItems();
  const index = items.findIndex((entry) => entry.id === item.id);
  $("frame-index").textContent = index >= 0 ? `${index + 1} / ${items.length}` : "";
  if (img.getAttribute("src") !== next) {
    resetZoom();
    img.onload = paint;
    img.onerror = paint;
    img.src = next;
  }
  if (img.complete) paint();
  preloadAround(item);
}

function setMode(mode) {
  state.mode = mode;
  $("reader").dataset.mode = mode;
  document.querySelectorAll(".modes [data-mode]").forEach((button) => {
    const on = button.dataset.mode === mode;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  });
}

let morphToken = 0;

function containedRect(box, width, height) {
  if (!width || !height || !box.width || !box.height) return box;
  const scale = Math.min(box.width / width, box.height / height);
  const nextWidth = width * scale;
  const nextHeight = height * scale;
  return {
    left: box.left + (box.width - nextWidth) / 2,
    top: box.top + (box.height - nextHeight) / 2,
    width: nextWidth,
    height: nextHeight,
  };
}

function placeFlyer(rect) {
  const flyer = $("morph-flyer");
  flyer.style.left = rect.left + "px";
  flyer.style.top = rect.top + "px";
  flyer.style.width = rect.width + "px";
  flyer.style.height = rect.height + "px";
}

function bloomNodes() {
  return [$("stage-blur"), document.querySelector("#reader .stage-shade"), document.querySelector("#reader .sheet")];
}

function localCenter(el, rect) {
  const box = el.getBoundingClientRect();
  const scaleX = box.width / el.offsetWidth || 1;
  const scaleY = box.height / el.offsetHeight || 1;
  return {
    x: el.offsetWidth / 2 + (rect.left + rect.width / 2 - (box.left + box.width / 2)) / scaleX,
    y: el.offsetHeight / 2 + (rect.top + rect.height / 2 - (box.top + box.height / 2)) / scaleY,
    scale: Math.max(scaleX, scaleY),
  };
}

function armBloom(rect) {
  const soft = 160;
  bloomNodes().forEach((el) => {
    if (!el) return;
    const point = localCenter(el, rect);
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const farthest = Math.max(
      Math.hypot(point.x, point.y),
      Math.hypot(point.x - width, point.y),
      Math.hypot(point.x, point.y - height),
      Math.hypot(point.x - width, point.y - height)
    );
    const inside = point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
    const outside = Math.hypot(
      point.x < 0 ? -point.x : point.x > width ? point.x - width : 0,
      point.y < 0 ? -point.y : point.y > height ? point.y - height : 0
    );
    const from = inside
      ? Math.min(rect.width, rect.height) / 2 / point.scale
      : outside + soft * 0.35;
    el.style.setProperty("--ox", point.x + "px");
    el.style.setProperty("--oy", point.y + "px");
    el.style.setProperty("--bloom-from", from + "px");
    el.style.setProperty("--bloom-end", farthest + soft + 12 + "px");
  });
}

function clearBloom() {
  $("reader").classList.remove("is-bloom");
  bloomNodes().forEach((el) => {
    if (!el) return;
    el.style.removeProperty("--ox");
    el.style.removeProperty("--oy");
    el.style.removeProperty("--bloom-from");
    el.style.removeProperty("--bloom-end");
  });
}

function stopMorph() {
  morphToken += 1;
  const flyer = $("morph-flyer");
  flyer.hidden = true;
  flyer.style.transition = "none";
  $("reader").classList.remove("is-morphing");
  clearBloom();
}

function playMorph(sourceImg) {
  const reader = $("reader");
  const flyer = $("morph-flyer");
  morphToken += 1;
  const token = morphToken;
  const from = sourceImg.getBoundingClientRect();
  flyer.hidden = false;
  flyer.src = sourceImg.currentSrc || sourceImg.src;
  flyer.style.transition = "none";
  flyer.style.objectFit = "cover";
  flyer.style.borderRadius = "18px";
  placeFlyer(from);
  flyer.offsetWidth;
  const moveMs = 340;
  const moveEase = "cubic-bezier(0.22, 0.7, 0.48, 0.74)";
  window.setTimeout(() => {
    if (token !== morphToken || !reader.open) return;
    const view = $("viewport").getBoundingClientRect();
    const to = containedRect(view, sourceImg.naturalWidth, sourceImg.naturalHeight);
    armBloom(to);
    flyer.style.transition = `left ${moveMs}ms ${moveEase}, top ${moveMs}ms ${moveEase}, width ${moveMs}ms ${moveEase}, height ${moveMs}ms ${moveEase}, border-radius ${moveMs}ms ${moveEase}`;
    flyer.style.objectFit = "contain";
    flyer.style.borderRadius = "2px";
    placeFlyer(to);
    window.setTimeout(() => {
      if (token !== morphToken || !reader.open) return;
      reader.classList.add("is-bloom");
    }, Math.round(moveMs * 0.72));
    window.setTimeout(() => {
      if (token !== morphToken || !reader.open) return;
      flyer.hidden = true;
      flyer.style.transition = "none";
      reader.classList.remove("is-morphing");
      reader.classList.add("is-bloom");
      window.setTimeout(() => {
        if (token !== morphToken) return;
        clearBloom();
      }, 680);
    }, moveMs);
  }, 16);
}

function openReader(id, sourceImg) {
  if ($("reader").open && state.activeId && state.activeId !== id && !confirmLeave()) return;
  const opening = !$("reader").open;
  $("reader").classList.remove("is-closing");
  if (!opening) stopMorph();
  state.activeId = id;
  state.editingPositive = false;
  state.editingTranslation = false;
  const opened = activeItem();
  $("negative-block").open = Boolean(opened && (opened.negative || "").trim());
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const morph = opening && sourceImg && !reduce;
  if (morph) $("reader").classList.add("is-morphing");
  if (opening) $("reader").showModal();
  setMode(state.mode || "both");
  fillReader();
  if (morph) playMorph(sourceImg);
  const nextHash = "#/prompts/" + encodeURIComponent(id);
  if (location.hash !== nextHash) location.hash = nextHash;
}

function closeReader(force) {
  const reader = $("reader");
  if (!reader.open || reader.classList.contains("is-closing")) return true;
  if (!force && !confirmLeave()) return false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  morphToken += 1;
  const flyer = $("morph-flyer");
  flyer.hidden = true;
  flyer.style.transition = "none";
  reader.classList.remove("is-morphing");
  clearBloom();
  if (reduce) {
    reader.close();
    return true;
  }
  reader.classList.add("is-closing");
  window.setTimeout(() => {
    if (reader.open) reader.close();
  }, 200);
  return true;
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

async function saveTranslation() {
  const item = activeItem();
  if (!item) return;
  const id = item.id;
  const negative = $("negative-zh-block").hidden ? (item.negativeTranslation || "") : $("negative-translation").value;
  $("save-state").textContent = "保存中…";
  try {
    const data = await api(`/api/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translation: $("translation").value,
        negativeTranslation: negative,
      }),
    });
    const latest = state.items.find((entry) => entry.id === id);
    state.editingTranslation = false;
    upsert(data.item, { dirty: false, busy: latest ? latest._busy : false });
    $("save-state").textContent = "已保存";
    render();
    fillReader();
  } catch (error) {
    $("save-state").textContent = "没保存上";
    toast(error.message);
    throw error;
  }
}

async function savePositive() {
  const item = activeItem();
  if (!item) return;
  const value = $("positive-edit").value;
  if (value !== (item.positive || "")) {
    const data = await api(`/api/items/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positive: value }),
    });
    upsert(data.item);
    render();
    $("save-state").textContent = "原文已保存";
  }
  state.editingPositive = false;
  fillReader();
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
  closeReader(true);
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
    if (card) openReader(card.dataset.id, card.querySelector("img"));
  });
  $("grid").addEventListener("keydown", (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openReader(card.dataset.id, card.querySelector("img"));
    }
  });
  $("reader-close").addEventListener("click", () => closeReader());
  $("reader").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeReader();
  });
  $("reader").addEventListener("close", () => {
    $("reader").classList.remove("is-closing");
    state.activeId = null;
    state.editingPositive = false;
    state.editingTranslation = false;
    resetZoom();
    stopMorph();
    if (document.fullscreenElement === $("reader")) document.exitFullscreen().catch(() => {});
    if (/^#\/prompts\//.test(location.hash) || location.hash.startsWith("#item=")) {
      history.replaceState(null, "", location.pathname + location.search + "#/prompts");
    }
  });
  $("prev-item").addEventListener("click", () => step(-1));
  $("next-item").addEventListener("click", () => step(1));
  const markUnsaved = () => {
    $("save-state").textContent = "未保存";
  };
  $("translation").addEventListener("input", markUnsaved);
  $("negative-translation").addEventListener("input", markUnsaved);
  $("positive-edit").addEventListener("input", markUnsaved);
  $("edit-positive").addEventListener("click", () => {
    state.editingPositive = true;
    $("positive-edit").value = (activeItem() || {}).positive || "";
    applyEditChrome();
    $("positive-edit").focus();
  });
  $("cancel-positive").addEventListener("click", () => {
    state.editingPositive = false;
    $("save-state").textContent = "";
    fillReader();
  });
  $("save-positive").addEventListener("click", () => {
    savePositive().catch((error) => toast(error.message));
  });
  $("edit-translation").addEventListener("click", () => {
    const item = activeItem() || {};
    state.editingTranslation = true;
    $("translation").value = item.translation || "";
    $("negative-translation").value = item.negativeTranslation || "";
    applyEditChrome();
    $("translation").focus();
  });
  $("cancel-translation").addEventListener("click", () => {
    state.editingTranslation = false;
    $("save-state").textContent = "";
    fillReader();
  });
  $("save-translation").addEventListener("click", () => {
    saveTranslation().catch(() => {});
  });
  document.querySelectorAll(".modes [data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  $("zoom-in").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("zoom-out").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("zoom-reset").addEventListener("click", resetZoom);
  $("zoom-full").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $("reader").requestFullscreen().catch(() => toast("这个浏览器没有打开全屏"));
  });
  document.addEventListener("fullscreenchange", () => {
    $("zoom-full").textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  });
  $("reader-img").addEventListener("dblclick", () => setZoom(state.zoom > 1 ? 1 : 2));
  $("viewport").addEventListener("wheel", (event) => {
    event.preventDefault();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });
  let pan = null;
  $("viewport").addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.zoom <= 1 || event.target.closest("button")) return;
    pan = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
    $("viewport").classList.add("is-dragging");
    $("viewport").setPointerCapture(event.pointerId);
  });
  $("viewport").addEventListener("pointermove", (event) => {
    if (!pan) return;
    state.panX = pan.panX + event.clientX - pan.x;
    state.panY = pan.panY + event.clientY - pan.y;
    applyZoom();
  });
  const endPan = () => {
    pan = null;
    $("viewport").classList.remove("is-dragging");
  };
  $("viewport").addEventListener("pointerup", endPan);
  $("viewport").addEventListener("pointercancel", endPan);
  $("retranslate").addEventListener("click", () => {
    const item = activeItem();
    if (!item) return;
    if (state.editingTranslation && promptDirty() && !confirm("重新翻译会丢掉未保存的译文。继续？")) return;
    state.editingTranslation = false;
    translateOne(item.id, hasTranslation(item)).catch((error) => toast(error.message));
  });
  $("copy-positive").addEventListener("click", () => copyText((activeItem() || {}).positive || ""));
  $("copy-zh").addEventListener("click", () => copyText((activeItem() || {}).translation || ""));
  $("copy-both").addEventListener("click", () => {
    const item = activeItem() || {};
    const parts = [item.positive, item.translation].filter((text) => (text || "").trim());
    copyText(parts.join("\n\n"));
  });
  $("copy-negative-zh").addEventListener("click", () => copyText((activeItem() || {}).negativeTranslation || ""));
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
      document.dispatchEvent(new Event("site-auth"));
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
    if (Site.current() !== "prompts") return;
    if (![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
    dragDepth += 1;
    $("drop").hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (Site.current() !== "prompts") return;
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    if (Site.current() !== "prompts") return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("drop").hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (Site.current() !== "prompts") return;
    dragDepth = 0;
    $("drop").hidden = true;
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      handleFiles(event.dataTransfer.files);
    }
  });
}

let promptsBoot = null;

function mountPrompts() {
  if (!promptsBoot) {
    bind();
    promptsBoot = boot().catch((error) => {
      $("grid").innerHTML = `<div class="empty"><h2>没有打开图库</h2><p>${esc(error.message)}</p></div>`;
    });
  }
  return promptsBoot;
}

function leavePrompts() {
  $("drop").hidden = true;
  const reader = $("reader");
  if (reader.open && !confirmLeave()) {
    const nextHash = state.activeId ? "#/prompts/" + encodeURIComponent(state.activeId) : "#/prompts";
    if (location.hash !== nextHash) location.hash = nextHash;
    return false;
  }
  if (reader.open) {
    morphToken += 1;
    reader.classList.remove("is-morphing", "is-closing", "is-bloom");
    clearBloom();
    reader.close();
  }
  if ($("settings").open) $("settings").close();
  return true;
}

function openFromRoute(rest) {
  const id = rest && rest[0] ? rest[0] : "";
  if (!id) {
    if ($("reader").open && !closeReader(false)) {
      const nextHash = "#/prompts/" + encodeURIComponent(state.activeId);
      if (location.hash !== nextHash) location.hash = nextHash;
    }
    return;
  }
  if (state.activeId === id && $("reader").open) return;
  if (state.items.some((item) => item.id === id)) openReader(id);
}

Site.register({
  id: "prompts",
  mark: "词",
  eyebrow: "AI 图片提示词",
  title: "看图，读提示词",
  navLabel: "提示词",
  summary: "看图，读出提示词，译成中文，译文可以改。",
  order: 10,
  element: "view-prompts",
  mount: mountPrompts,
  unmount: leavePrompts,
  onRoute(_ctx, rest) { openFromRoute(rest); },
});
