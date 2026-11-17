/* LoRA 板块。列表、详情弹窗、添加和删除都在这里。 */
(() => {
  const state = {
    items: [],
    query: "",
    activeId: null,
    imageIndex: 0,
  };
  let reader = null;
  let form = null;
  let grid = null;
  let countNode = null;
  let pageCtx = null;
  let generation = 0;
  let morphToken = 0;
  let timers = [];

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
    if (/^\/lora-samples\/[A-Za-z0-9_-]+\/\d{2}\.(jpg|png|webp)$/.test(url || "")) return url;
    if (/^\/lora-media\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(url || "")) return url;
    return "";
  }

  function safeHref(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    } catch (_error) {
      return "";
    }
    return "";
  }

  function excerpt(text) {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (!flat || flat === "无") return "没有简介";
    return flat.length > 72 ? flat.slice(0, 72) + "…" : flat;
  }

  function later(fn, ms) {
    const id = window.setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function clearTimers() {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...options });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new Error("服务没有响应。本地请运行 start.bat；如果已经部署，请检查 Python 服务是否在运行。");
    }
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json() : null;
    if (response.status === 401) {
      const gate = document.getElementById("gate");
      if (gate && !gate.open) gate.showModal();
      throw new Error((data && data.error) || "需要访问口令");
    }
    if (!response.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || `请求失败（${response.status}）`);
    }
    return data;
  }

  function visibleItems() {
    const query = state.query.trim().toLowerCase();
    return state.items.filter((item) => {
      if (!query) return true;
      return [item.name, item.base, item.summary, item.url].join("\n").toLowerCase().includes(query);
    });
  }

  function activeItem() {
    return state.items.find((item) => item.id === state.activeId) || null;
  }

  function render() {
    if (!grid) return;
    const items = visibleItems();
    const total = state.items.length;
    if (countNode) {
      countNode.textContent = total
        ? (items.length === total ? `${total} 个 LoRA` : `${items.length} / ${total} 个 LoRA`)
        : "";
    }
    if (!items.length) {
      grid.innerHTML = total
        ? `<div class="empty"><h2>没有匹配的 LoRA</h2><p>换个词再搜。</p></div>`
        : `<div class="empty"><h2>还没有 LoRA</h2><p>点「添加 LoRA」，放上样例图，并写上名称、底模、简介和网址。</p></div>`;
      return;
    }
    grid.innerHTML = items.map((item) => {
      const cover = safeSrc((item.images || [])[0]);
      const pictures = (item.images || []).length;
      return `<article class="card lora-card" data-id="${esc(item.id)}" tabindex="0" role="button">
        <div class="thumb">
          ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : ""}
          <span class="pill">${esc(item.base || "未填底模")}</span>
        </div>
        <div class="body">
          <h2 class="lora-title">${esc(item.name || "未命名")}</h2>
          <p class="excerpt">${esc(excerpt(item.summary))}${pictures ? ` · ${pictures} 张` : ""}</p>
        </div>
      </article>`;
    }).join("");
  }

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
    const flyer = document.getElementById("lora-flyer");
    flyer.style.left = rect.left + "px";
    flyer.style.top = rect.top + "px";
    flyer.style.width = rect.width + "px";
    flyer.style.height = rect.height + "px";
  }

  function bloomNodes() {
    return [document.getElementById("lora-blur"), reader.querySelector(".stage-shade"), reader.querySelector(".sheet")];
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
      const from = inside ? Math.min(rect.width, rect.height) / 2 / point.scale : outside + soft * 0.35;
      el.style.setProperty("--ox", point.x + "px");
      el.style.setProperty("--oy", point.y + "px");
      el.style.setProperty("--bloom-from", from + "px");
      el.style.setProperty("--bloom-end", farthest + soft + 12 + "px");
    });
  }

  function clearBloom() {
    if (!reader) return;
    reader.classList.remove("is-bloom");
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
    const flyer = document.getElementById("lora-flyer");
    if (flyer) {
      flyer.hidden = true;
      flyer.style.transition = "none";
    }
    if (reader) reader.classList.remove("is-morphing");
    clearBloom();
  }

  function playMorph(sourceImg) {
    const flyer = document.getElementById("lora-flyer");
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
    later(() => {
      if (token !== morphToken || !reader || !reader.open) return;
      const view = document.getElementById("lora-viewport").getBoundingClientRect();
      const to = containedRect(view, sourceImg.naturalWidth, sourceImg.naturalHeight);
      armBloom(to);
      flyer.style.transition = `left ${moveMs}ms ${moveEase}, top ${moveMs}ms ${moveEase}, width ${moveMs}ms ${moveEase}, height ${moveMs}ms ${moveEase}, border-radius ${moveMs}ms ${moveEase}`;
      flyer.style.objectFit = "contain";
      flyer.style.borderRadius = "2px";
      placeFlyer(to);
      later(() => {
        if (token !== morphToken || !reader || !reader.open) return;
        reader.classList.add("is-bloom");
      }, Math.round(moveMs * 0.72));
      later(() => {
        if (token !== morphToken || !reader || !reader.open) return;
        flyer.hidden = true;
        flyer.style.transition = "none";
        reader.classList.remove("is-morphing");
        reader.classList.add("is-bloom");
        later(() => {
          if (token !== morphToken) return;
          clearBloom();
        }, 680);
      }, moveMs);
    }, 16);
  }

  function showImage(index) {
    const item = activeItem();
    const images = (item && item.images || []).map(safeSrc).filter(Boolean);
    const frame = document.getElementById("lora-frame");
    const photo = document.getElementById("lora-img");
    const blur = document.getElementById("lora-blur");
    const thumbs = document.getElementById("lora-thumbs");
    if (!item) return;
    state.imageIndex = images.length ? (index + images.length) % images.length : 0;
    const src = images[state.imageIndex] || "";
    photo.src = src;
    photo.alt = item.name || "";
    blur.style.backgroundImage = src ? `url("${src}")` : "";
    frame.textContent = images.length ? `${state.imageIndex + 1} / ${images.length}` : "没有样例图";
    document.getElementById("lora-prev").hidden = images.length < 2;
    document.getElementById("lora-next").hidden = images.length < 2;
    thumbs.innerHTML = images.map((image, imageIndex) => {
      const on = imageIndex === state.imageIndex ? " is-on" : "";
      return `<button type="button" class="${on.trim()}" data-index="${imageIndex}" aria-label="第 ${imageIndex + 1} 张"><img src="${esc(image)}" alt=""></button>`;
    }).join("");
  }

  function fillReader() {
    const item = activeItem();
    if (!item || !reader) return;
    document.getElementById("lora-name").textContent = item.name || "未命名";
    document.getElementById("lora-base").textContent = item.base ? `底模 ${item.base}` : "未填底模";
    const summary = (item.summary || "").trim();
    document.getElementById("lora-summary").textContent = !summary || summary === "无" ? "没有简介" : summary;
    const row = document.getElementById("lora-url");
    row.replaceChildren();
    const href = safeHref(item.url);
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = item.url;
      row.append(link);
    } else {
      row.textContent = "没有网址";
    }
    showImage(state.imageIndex || 0);
  }

  function syncHash(id) {
    const next = id ? "#/lora/" + encodeURIComponent(id) : "#/lora";
    if (location.hash !== next) location.hash = next;
  }

  function openReader(id, sourceImg) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || !reader) return;
    const opening = !reader.open;
    if (!opening) stopMorph();
    state.activeId = id;
    state.imageIndex = 0;
    reader.classList.remove("is-closing");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const morph = opening && sourceImg && sourceImg.getAttribute("src") && !reduce;
    if (morph) reader.classList.add("is-morphing");
    if (opening) reader.showModal();
    fillReader();
    if (morph) playMorph(sourceImg);
    syncHash(id);
  }

  function closeReader(fromRoute) {
    if (!reader || !reader.open || reader.classList.contains("is-closing")) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stopMorph();
    state.activeId = null;
    if (reduce) reader.close();
    else {
      reader.classList.add("is-closing");
      later(() => {
        if (!reader) return;
        reader.classList.remove("is-closing");
        if (reader.open) reader.close();
      }, 200);
    }
    if (!fromRoute) syncHash("");
  }

  function stepModel(delta) {
    const items = visibleItems();
    const index = items.findIndex((item) => item.id === state.activeId);
    if (index < 0 || items.length < 2) return;
    const next = items[(index + delta + items.length) % items.length];
    openReader(next.id);
  }

  async function load() {
    const gen = generation;
    const data = await api("/api/loras", { signal: pageCtx && pageCtx.signal });
    if (gen !== generation) return;
    state.items = data.items || [];
    render();
  }

  function removeDialogs() {
    clearTimers();
    morphToken += 1;
    [reader, form].forEach((dialog) => {
      if (!dialog) return;
      dialog.classList.remove("is-morphing", "is-closing", "is-bloom");
      if (dialog.open) dialog.close();
      dialog.remove();
    });
    reader = null;
    form = null;
  }

  function buildReader() {
    reader = document.createElement("dialog");
    reader.id = "lora-reader";
    reader.setAttribute("aria-label", "LoRA 详情");
    reader.innerHTML = `<img id="lora-flyer" class="morph-flyer" alt="" hidden>
      <div class="reader-layout">
        <section class="stage">
          <div id="lora-blur" class="stage-blur" aria-hidden="true"></div>
          <div class="stage-shade" aria-hidden="true"></div>
          <button type="button" id="lora-prev" class="nav-btn prev">上一张</button>
          <button type="button" id="lora-next" class="nav-btn next">下一张</button>
          <div id="lora-viewport" class="viewport"><img id="lora-img" alt="" draggable="false"></div>
          <div id="lora-thumbs" class="lora-thumbs"></div>
          <div class="stage-info"><span id="lora-frame"></span></div>
        </section>
        <div class="sheet">
          <div class="sheet-bar">
            <h2 id="lora-name"></h2>
            <button type="button" id="lora-close" class="btn icon">关闭</button>
          </div>
          <div class="chips"><span id="lora-base"></span></div>
          <div class="sheet-scroll">
            <h3>简介</h3>
            <pre id="lora-summary" class="prompt"></pre>
            <h3>网址</h3>
            <p id="lora-url" class="lora-url"></p>
          </div>
          <div class="sheet-foot">
            <button type="button" id="lora-prev-model" class="btn ghost">上一个</button>
            <button type="button" id="lora-next-model" class="btn ghost">下一个</button>
            <button type="button" id="lora-delete" class="btn danger">删除</button>
          </div>
        </div>
      </div>`;
    document.body.append(reader);
    reader.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeReader(false);
    });
    reader.querySelector("#lora-close").addEventListener("click", () => closeReader(false));
    reader.querySelector("#lora-prev").addEventListener("click", () => showImage(state.imageIndex - 1));
    reader.querySelector("#lora-next").addEventListener("click", () => showImage(state.imageIndex + 1));
    reader.querySelector("#lora-prev-model").addEventListener("click", () => stepModel(-1));
    reader.querySelector("#lora-next-model").addEventListener("click", () => stepModel(1));
    reader.querySelector("#lora-thumbs").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      showImage(Number(button.dataset.index) || 0);
    });
    reader.querySelector("#lora-delete").addEventListener("click", async () => {
      const item = activeItem();
      if (!item) return;
      const message = item.sample
        ? "从列表里移出这个示例？图片文件还在，可以用「恢复示例」加回来。"
        : "删除这个 LoRA？添加的图片也会一起删掉。";
      if (!window.confirm(message)) return;
      try {
        await api("/api/loras/" + encodeURIComponent(item.id), { method: "DELETE", signal: pageCtx.signal });
        state.items = state.items.filter((entry) => entry.id !== item.id);
        closeReader(false);
        render();
        Site.toast("已删除");
      } catch (error) {
        if (error.name === "AbortError") return;
        Site.toast(error.message);
      }
    });
  }

  function buildForm() {
    form = document.createElement("dialog");
    form.id = "lora-form";
    form.setAttribute("aria-labelledby", "lora-form-title");
    form.innerHTML = `<form>
      <div class="sheet-bar">
        <h2 id="lora-form-title">添加 LoRA</h2>
        <button type="button" id="lora-form-close" class="btn icon">关闭</button>
      </div>
      <label>名称<input id="lora-field-name" name="name" required maxlength="120" autocomplete="off"></label>
      <label>底模<input id="lora-field-base" name="base" required maxlength="80" value="krea2" autocomplete="off"></label>
      <label>简介<textarea id="lora-field-summary" name="summary" maxlength="12000" placeholder="触发词、推荐权重、出图参数"></textarea></label>
      <label>网址<input id="lora-field-url" name="url" type="url" inputmode="url" placeholder="https://" autocomplete="off"></label>
      <label class="btn ghost file-btn">选择样例图<input id="lora-field-files" name="files" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple hidden></label>
      <p id="lora-file-note" class="note">选 4 到 5 张，最多 8 张。PNG、JPEG 或 WebP。</p>
      <div class="row-actions"><button type="submit" id="lora-save" class="btn primary">保存</button></div>
      <p id="lora-form-msg" class="note"></p>
    </form>`;
    document.body.append(form);
    const files = form.querySelector("#lora-field-files");
    files.addEventListener("change", () => {
      const note = form.querySelector("#lora-file-note");
      const count = files.files ? files.files.length : 0;
      note.textContent = count ? `已选 ${count} 张。最多 8 张。` : "选 4 到 5 张，最多 8 张。PNG、JPEG 或 WebP。";
    });
    form.querySelector("#lora-form-close").addEventListener("click", () => form.close());
    form.addEventListener("cancel", (event) => {
      event.preventDefault();
      form.close();
    });
    form.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = form.querySelector("#lora-form-msg");
      const save = form.querySelector("#lora-save");
      message.textContent = "";
      const name = form.querySelector("#lora-field-name").value.trim();
      const base = form.querySelector("#lora-field-base").value.trim();
      const summary = form.querySelector("#lora-field-summary").value;
      const url = form.querySelector("#lora-field-url").value.trim();
      const chosen = [...(files.files || [])];
      if (!name || !base) {
        message.textContent = "名称和底模都要填。";
        return;
      }
      if (!chosen.length) {
        message.textContent = "请至少选一张样例图。";
        return;
      }
      if (chosen.length > 8) {
        message.textContent = "最多 8 张样例图。";
        return;
      }
      const allowed = /\.(png|jpe?g|webp)$/i;
      const badFile = chosen.some((file) => {
        const typeOk = !file.type || /^image\/(png|jpeg|webp)$/.test(file.type);
        const nameOk = allowed.test(file.name || "image.png");
        return !typeOk || !nameOk;
      });
      if (badFile) {
        message.textContent = "只支持 PNG、JPEG、WebP。";
        return;
      }
      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad");
        } catch (_error) {
          message.textContent = "网址需要以 http:// 或 https:// 开头。";
          return;
        }
      }
      save.disabled = true;
      const gen = generation;
      let created = null;
      try {
        const payload = await api("/api/loras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, base, summary, url }),
          signal: pageCtx.signal,
        });
        created = payload.item;
        for (let index = 0; index < chosen.length; index += 1) {
          const file = chosen[index];
          message.textContent = `正在上传 ${index + 1} / ${chosen.length}`;
          const uploaded = await api("/api/loras/" + encodeURIComponent(created.id) + "/images", {
            method: "POST",
            headers: { "X-Filename": encodeURIComponent(file.name || "image.png") },
            body: file,
            signal: pageCtx.signal,
          });
          created = uploaded.item;
        }
        if (gen !== generation) return;
        form.close();
        event.target.reset();
        form.querySelector("#lora-field-base").value = "krea2";
        await load();
        openReader(created.id);
        Site.toast("已添加");
      } catch (error) {
        if (error.name === "AbortError") return;
        if (created && gen === generation) await load().catch(() => {});
        message.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
  }

  function onKey(event) {
    if (!reader || !reader.open) return;
    if (event.target.matches("textarea, input")) return;
    if (event.key === "ArrowLeft") showImage(state.imageIndex - 1);
    if (event.key === "ArrowRight") showImage(state.imageIndex + 1);
  }

  async function mount(ctx) {
    pageCtx = ctx;
    generation += 1;
    const gen = generation;
    removeDialogs();
    const search = document.createElement("label");
    search.className = "search";
    search.innerHTML = `<span class="sr">搜索</span><input type="search" placeholder="搜索名称、底模、简介" autocomplete="off">`;
    const restore = Object.assign(document.createElement("button"), { type: "button", className: "btn ghost", textContent: "恢复示例" });
    const add = Object.assign(document.createElement("button"), { type: "button", className: "btn primary", textContent: "添加 LoRA" });
    ctx.tools.append(search, restore, add);
    countNode = document.createElement("p");
    countNode.className = "count";
    grid = document.createElement("main");
    grid.className = "grid";
    grid.setAttribute("aria-live", "polite");
    ctx.root.append(countNode, grid);
    ctx.setFoot("示例和后来添加的 LoRA 写在这台机器的 data 目录。点开可以看样例图、底模、简介和网址。");
    search.querySelector("input").addEventListener("input", (event) => {
      state.query = event.target.value;
      render();
    });
    restore.addEventListener("click", async () => {
      try {
        const data = await api("/api/loras/restore", { method: "POST", signal: ctx.signal });
        await load();
        Site.toast(data.added ? `已恢复 ${data.added} 个示例` : "示例都在");
      } catch (error) {
        if (error.name === "AbortError") return;
        Site.toast(error.message);
      }
    });
    add.addEventListener("click", () => {
      form.querySelector("#lora-form-msg").textContent = "";
      if (!form.open) form.showModal();
    });
    grid.addEventListener("click", (event) => {
      const card = event.target.closest(".card");
      if (!card) return;
      openReader(card.dataset.id, card.querySelector("img"));
    });
    grid.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest(".card");
      if (!card) return;
      event.preventDefault();
      openReader(card.dataset.id, card.querySelector("img"));
    });
    buildReader();
    buildForm();
    document.addEventListener("keydown", onKey);
    ctx.signal.addEventListener("abort", () => {
      document.removeEventListener("keydown", onKey);
    });
    grid.innerHTML = `<div class="empty"><h2>正在读取</h2><p>稍等一下。</p></div>`;
    try {
      await load();
    } catch (error) {
      if (gen !== generation || error.name === "AbortError") return;
      grid.innerHTML = `<div class="empty"><h2>没有打开列表</h2><p>${esc(error.message)}</p></div>`;
    }
  }

  function unmount() {
    generation += 1;
    document.removeEventListener("keydown", onKey);
    state.activeId = null;
    removeDialogs();
    grid = null;
    countNode = null;
    pageCtx = null;
    return true;
  }

  function onRoute(_ctx, rest) {
    const id = rest && rest[0] ? rest[0] : "";
    if (!id) {
      if (reader && reader.open) closeReader(true);
      return;
    }
    if (state.activeId === id && reader && reader.open) return;
    if (state.items.some((item) => item.id === id)) openReader(id);
  }

  document.addEventListener("site-auth", () => {
    if (Site.current() === "lora" && pageCtx) load().catch((error) => Site.toast(error.message));
  });

  Site.register({
    id: "lora",
    mark: "模",
    eyebrow: "LoRA 参数",
    title: "看模型，读参数",
    navLabel: "LoRA",
    summary: "看样例图、底模和简介，也可以自己添加。",
    order: 20,
    ready: true,
    mount,
    unmount,
    onRoute,
  });
})();
