/* 板块模板。复制本文件并改名，再在 index.html 里 Site.start() 之前加上 script。
 * 不要直接引入本文件，这里没有登记任何板块。
 *
 * Site.register({
 *   id: "notes",
 *   mark: "记",
 *   eyebrow: "笔记",
 *   title: "还没写标题",
 *   navLabel: "笔记",
 *   summary: "首页卡片上的一句话。",
 *   order: 20,
 *   ready: false
 * });
 *
 * 界面准备好以后把 ready 改成 true，并补上 mount：
 *
 * Site.register({
 *   id: "notes",
 *   mark: "记",
 *   eyebrow: "笔记",
 *   title: "标题",
 *   navLabel: "笔记",
 *   summary: "首页卡片上的一句话。",
 *   order: 20,
 *   ready: true,
 *   mount(ctx) {
 *     ctx.tools.append(Object.assign(document.createElement("button"), {
 *       type: "button",
 *       className: "btn primary",
 *       textContent: "新建"
 *     }));
 *     ctx.root.innerHTML = '<div class="section-placeholder"><div class="empty"><h2>笔记</h2><p>内容写在这里。</p></div></div>';
 *     ctx.setFoot("页脚说明，不需要就不要调用。");
 *     ctx.signal.addEventListener("abort", () => {});
 *   },
 *   unmount() {}
 * });
 */
