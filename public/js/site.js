/* 站点壳。提示词只是其中一个板块。
 *
 * 新板块：复制 public/js/sections/template.js，在 index.html 的 Site.start() 之前引入。
 *
 * Site.register({
 *   id: "notes",          // 地址 #/notes。字母开头，只能含字母、数字、短横线、下划线
 *   mark: "记",           // 页头方块里的一个字
 *   eyebrow: "笔记",
 *   title: "标题",        // 页头大标题
 *   navLabel: "笔记",     // 顶栏和首页卡片上的短名，缺省用 title
 *   summary: "首页卡片上的一句话",
 *   order: 20,            // 越小越靠前
 *   ready: true,          // false 时不调用 mount，直接用共用的空态
 *   element: "view-id",   // 可选。页面里已经写好的节点，壳只负责显示和隐藏
 *   mount(ctx) {},        // ctx.root 内容区，ctx.tools 页头右侧
 *   unmount(ctx) {},      // 返回 false 可取消这次离开
 *   onRoute(ctx, rest) {},// 同一板块里 hash 后面的路径变了。#/notes/a → rest 是 ["a"]
 * })
 *
 * ctx.toast(文字)、ctx.setFoot(文字)、ctx.navigate(板块id)、ctx.signal
 * 离开板块时 signal 会中止。按钮、卡片、空态沿用 app.css 里的 .btn .chip .card .empty .note。
 * 进入板块时壳会播放和阅读器同一条缓动的上浮动画。
 */
const Site = (() => {
  const sections = [];
  let active = null;
  let navToken = 0;
  let registerSeq = 0;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function register(section) {
    if (!section || typeof section !== "object") throw new Error("板块登记要传入对象");
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(section.id || "")) {
      throw new Error("板块 id 要以字母开头，只能含字母、数字、短横线和下划线");
    }
    if (section.id === "home") throw new Error("home 留给首页");
    if (sections.some((item) => item.id === section.id)) throw new Error("板块 id 重复：" + section.id);
    sections.push({ ...section, _seq: registerSeq += 1 });
    sections.sort((a, b) => (a.order || 0) - (b.order || 0) || a._seq - b._seq);
  }

  function toast(message) {
    const node = document.getElementById("toast");
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(node._timer);
    node._timer = setTimeout(() => {
      node.hidden = true;
    }, 4200);
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, "");
    const legacy = raw.match(/^item=(.*)$/);
    if (legacy) return { redirect: "#/prompts/" + legacy[1] };
    const path = raw.replace(/^\//, "");
    if (!path) return { name: "home", rest: [] };
    const parts = path.split("/").filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); }
      catch (_error) { return part; }
    });
    return { name: parts[0], rest: parts.slice(1) };
  }

  function renderNav(currentId) {
    const nav = document.getElementById("site-nav");
    const links = [{ id: "home", label: "首页", href: "#/" }].concat(sections.map((section) => ({
      id: section.id,
      label: section.navLabel || section.title || section.id,
      href: "#/" + encodeURIComponent(section.id),
    })));
    nav.innerHTML = links.map((link) => {
      const on = link.id === currentId;
      return `<a href="${link.href}" class="${on ? "is-on" : ""}"${on ? ' aria-current="page"' : ""}>${esc(link.label)}</a>`;
    }).join("");
  }

  function renderHome() {
    const grid = document.getElementById("home-grid");
    const cards = sections.map((section) => `<a class="section-card" href="#/${encodeURIComponent(section.id)}">
      <span class="mark" aria-hidden="true">${esc(section.mark || "板")}</span>
      <div class="section-copy">
        <p class="eyebrow">${esc(section.eyebrow || "")}</p>
        <h2>${esc(section.navLabel || section.title || section.id)}</h2>
        <p class="section-summary">${esc(section.summary || "")}</p>
      </div>
    </a>`).join("");
    grid.innerHTML = cards + `<article class="section-card is-reserved">
      <span class="mark mark-ghost" aria-hidden="true">+</span>
      <div class="section-copy">
        <p class="eyebrow">预留</p>
        <h2>下一个板块</h2>
        <p class="section-summary">在 <code>public/js/sections/</code> 里新增脚本，调用 <code>Site.register</code>。页头、按钮和进入动画沿用现在这套。</p>
      </div>
    </article>`;
  }

  function reveal(node) {
    document.querySelectorAll(".view").forEach((view) => {
      view.hidden = view !== node;
      view.classList.remove("is-entering");
    });
    node.hidden = false;
    void node.offsetWidth;
    node.classList.add("is-entering");
  }

  function makeContext() {
    const controller = new AbortController();
    const ctx = {
      root: document.getElementById("mount-stage"),
      tools: document.getElementById("mount-tools"),
      signal: controller.signal,
      toast,
      navigate(id) { location.hash = "/" + String(id || ""); },
      setFoot(text) {
        const foot = document.getElementById("mount-foot");
        const value = text ? String(text) : "";
        foot.textContent = value;
        foot.hidden = !value;
      },
    };
    return { ctx, abort: () => controller.abort() };
  }

  function resetMount() {
    document.getElementById("mount-tools").replaceChildren();
    document.getElementById("mount-stage").replaceChildren();
    const foot = document.getElementById("mount-foot");
    foot.textContent = "";
    foot.hidden = true;
  }

  function fillMount(section) {
    document.getElementById("mount-mark").textContent = section.mark || "板";
    document.getElementById("mount-eyebrow").textContent = section.eyebrow || "";
    document.getElementById("mount-title").textContent = section.title || section.id;
  }

  function paintPending(section) {
    document.getElementById("mount-stage").innerHTML = `<div class="section-placeholder"><div class="empty"><h2>${esc(section.title || section.id)}</h2><p>${esc(section.summary || "这个板块还没接上界面。")}</p></div></div>`;
  }

  function leaveCurrent() {
    if (!active) return true;
    const leaving = active;
    if (typeof leaving.section.unmount === "function" && leaving.section.unmount(leaving.ctx) === false) return false;
    leaving.abort();
    active = null;
    return true;
  }

  async function showRoute(route) {
    const seq = ++navToken;
    if (route.redirect) {
      location.replace(route.redirect);
      return;
    }
    if (route.name === "home") {
      if (!leaveCurrent()) return;
      if (seq !== navToken) return;
      renderNav("home");
      renderHome();
      reveal(document.getElementById("view-home"));
      document.title = "站点";
      return;
    }

    const section = sections.find((item) => item.id === route.name);
    if (!section) {
      if (!leaveCurrent()) return;
      if (seq !== navToken) return;
      renderNav("home");
      resetMount();
      fillMount({ mark: "无", eyebrow: "站点", title: "没有这个板块" });
      paintPending({ title: "没有这个板块", summary: "地址对不上已登记的板块。" });
      reveal(document.getElementById("view-mount"));
      document.title = "站点";
      return;
    }

    const same = active && active.section.id === section.id;
    if (!same) {
      if (!leaveCurrent()) return;
      if (seq !== navToken) return;
      const made = makeContext();
      active = { section, ctx: made.ctx, abort: made.abort };
      renderNav(section.id);
      document.title = (section.navLabel || section.title || section.id) + " · 站点";
      if (section.element) {
        const node = document.getElementById(section.element);
        if (!node) throw new Error("找不到板块节点 " + section.element);
        reveal(node);
      } else {
        resetMount();
        fillMount(section);
        reveal(document.getElementById("view-mount"));
        if (section.ready === false || typeof section.mount !== "function") paintPending(section);
        else await section.mount(made.ctx);
      }
      if (seq !== navToken) return;
      if (section.element && typeof section.mount === "function") await section.mount(made.ctx);
      if (seq !== navToken) return;
    }

    if (active && typeof active.section.onRoute === "function") {
      active.section.onRoute(active.ctx, route.rest || []);
    }
  }

  function start() {
    window.addEventListener("hashchange", () => { showRoute(parseHash()); });
    showRoute(parseHash());
  }

  function current() {
    return active ? active.section.id : "home";
  }

  return { register, start, toast, current };
})();
