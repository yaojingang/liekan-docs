import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const flush = () => new Promise(setImmediate);
const response = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
const resource = (title = "系统使用指南", fileType = "html") => ({
  slug: "resource-guide",
  title,
  fileName: `guide.${fileType === "word" ? "docx" : fileType}`,
  fileType,
  size: 2048,
  directoryName: "使用指南",
  uploadTime: "10/08 09:20",
  updatedTime: "10/09 10:30",
  updatedDate: "2025-10-09",
  url: "/resource-guide",
});
function result(pages = [resource()], options = {}) {
  const total = options.total ?? pages.length;
  const page = options.page ?? 1;
  const totalPages = Math.max(1, Math.ceil(total / 10));
  return {
    pages,
    stats: options.stats ?? { all: 31, html: 29, pdf: 1, word: 1 },
    pagination: {
      page,
      pageSize: 10,
      total,
      totalPages,
      offset: (page - 1) * 10,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function harness(fetchImpl = async () => response(result()), url = "/?view=resources", layout) {
  const { document, window } = parseHTML(
    await fs.readFile("public/index-public.html", "utf8"),
  );
  const listeners = new Map(),
    timers = new Map(),
    calls = [],
    historyCalls = [];
  let active = document.body,
    nextTimer = 0;
  Object.defineProperty(document, "activeElement", { get: () => active });
  window.HTMLElement.prototype.focus = function () {
    active = this;
  };
  window.HTMLElement.prototype.scrollIntoView = function () {
    this.dataset.scrolled = "true";
  };
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() {
      return (
        this.querySelector("option[selected]")?.value ||
        this.querySelector("option")?.value ||
        ""
      );
    },
    set(value) {
      this.querySelectorAll("option").forEach((o) =>
        o.toggleAttribute("selected", o.value === value),
      );
    },
  });
  if (layout) {
    const main = document.querySelector("#publicNavLinks");
    const guide = document.createElement("a");
    guide.className = "public-menu-link";
    guide.dataset.navId = "guide";
    guide.href = layout.guideUrl || "/type/html";
    guide.textContent = "使用指南";
    main.prepend(guide);
    Object.defineProperty(window, "innerWidth", { configurable: true, get: () => layout.viewportWidth });
    Object.defineProperty(document.querySelector("#publicNavigation"), "clientWidth", { get: () => layout.width });
    Object.defineProperty(main, "scrollWidth", { get: () => main.children.length * 80 });
    for (const link of main.children) link.getBoundingClientRect = () => ({ width: 80 });
    document.querySelector("#publicNavMore").getBoundingClientRect = () => ({ width: 64 });
  }
  const addEventListener = window.addEventListener.bind(window);
  window.addEventListener = (name, callback) => {
    listeners.set(name, callback);
    addEventListener(name, callback);
  };
  const location = new URL(url, "http://test");
  const history = Object.fromEntries(
    ["pushState", "replaceState"].map((method) => [
      method,
      (state, title, path) => {
        historyCalls.push({ method, path });
        location.href = new URL(path, location).href;
      },
    ]),
  );
  const context = vm.createContext({
    document,
    window,
    location,
    history,
    console,
    URL,
    URLSearchParams,
    Intl,
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch(path, options) {
      calls.push(path);
      return fetchImpl(path, options);
    },
  });
  let ui = await fs.readFile("public/ui.js", "utf8");
  ui = ui.slice(0, ui.indexOf("export function initShell"));
  vm.runInContext(
    ui.replace(/^export /gm, "") +
      "\nconst esc = escapeHtml; function initShell() {}",
    context,
  );
  const source = (await fs.readFile("public/public-app.js", "utf8")).replace(
    /^import[\s\S]+?from ["']\.\/ui\.js\?v=[^"']+["'];\n/,
    "",
  );
  vm.runInContext(source, context);
  const click = (selector, options = {}) => {
    const target =
      typeof selector === "string"
        ? document.querySelector(selector)
        : selector;
    assert.ok(target, String(selector));
    const event = {
      target,
      button: 0,
      preventDefault() {
        this.prevented = true;
      },
      ...options,
    };
    const parent = target.closest(
      "#publicHomeLink, #allDocumentsLink, #statsLine, #pagination, #emptyState, #homeViewAll",
    );
    assert.ok(
      parent?.onclick,
      "click must exercise the actual delegated handler",
    );
    parent.onclick(event);
    return event;
  };
  return {
    document,
    window,
    calls,
    historyCalls,
    location,
    timers,
    click,
    resize(viewportWidth, width) {
      Object.assign(layout, { viewportWidth, width });
      listeners.get("resize")();
    },
    async input(value) {
      const el = document.querySelector("#searchInput");
      el.focus();
      el.value = value;
      el.oninput();
    },
    async tick() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
      await flush();
    },
    async navigate(path) {
      location.href = new URL(path, location).href;
      listeners.get("popstate")();
      await flush();
    },
  };
}

test("public first load selects its deep-link category without presenting unknown counts as zero", async () => {
  const pending = deferred();
  const h = await harness(
    () => pending.promise,
    "/type/pdf?q=年度&sort=created_desc&page=3",
  );
  assert.equal(
    h.document.querySelector(".shell-sidebar"),
    null,
  );
  assert.equal(
    h.document.querySelector('#statsLine [aria-current="page"]').dataset.type,
    "pdf",
  );
  assert.equal(
    h.document.querySelector("#publicListTitle").textContent,
    "PDF文档",
  );
  assert.equal(
    h.document.querySelector("#timeHeading").textContent,
    "更新日期",
  );
  assert.notEqual(
    h.document.querySelector('[data-count="all"]').textContent,
    "0",
  );
  assert.equal(h.document.querySelector("#publicTable").hidden, true);
  pending.resolve(response(result([], { total: 0 })));
  await flush();
  assert.equal(h.location.search.includes("page="), false);
});

test("public resource cards share category state and preserve stable focused nodes and global counts", async () => {
  const h = await harness();
  await flush();
  const card = h.document.querySelector('#statsLine [data-type="pdf"]');
  card.focus();
  h.click(card);
  await flush();
  assert.equal(h.document.querySelector('#statsLine [data-type="pdf"]'), card);
  assert.equal(h.document.activeElement, card);
  assert.equal(
    h.document.querySelector(".shell-sidebar"),
    null,
  );
  assert.equal(
    h.document.querySelector('#statsLine [data-count="all"]').textContent,
    "31",
  );
  assert.equal(
    h.document.querySelector("#publicListCount").textContent,
    "当前结果 1 条",
  );
  const count = h.historyCalls.length;
  h.click(card);
  await flush();
  assert.equal(
    h.historyCalls.length,
    count,
    "same URL must not add duplicate history",
  );
});

test("public search pending at pagination is committed once and cannot be replayed over the new result", async () => {
  const h = await harness(async () =>
    response(result([resource()], { total: 23 })),
  );
  await flush();
  await h.input("最新指南");
  h.click('#pagination [data-page="2"]');
  await flush();
  await h.tick();
  assert.equal(h.calls.length, 2);
  const q = new URL(h.calls.at(-1), h.location).searchParams;
  assert.equal(q.get("q"), "最新指南");
  assert.equal(q.get("page"), "1");
});

test("public category links preserve draft search and sort for native modified clicks", async () => {
  const h = await harness(undefined, "/?sort=created_desc");
  await flush();
  await h.input("A & 年度");
  const card = h.document.querySelector('#statsLine [data-type="word"]');
  const href = new URL(card.getAttribute("href"), h.location);
  assert.equal(href.searchParams.get("q"), "A & 年度");
  assert.equal(href.searchParams.get("sort"), "created_desc");
  const event = h.click(card, { ctrlKey: true });
  assert.equal(event.prevented, undefined);
  assert.equal(h.calls.length, 1);
  h.click(card);
  await flush();
  await h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.location.pathname, "/type/word");
});

test("public loading and failure keep current controls while excluding stale rows and stale result counts", async () => {
  const pending = deferred();
  let request = 0;
  const h = await harness(() =>
    ++request === 1 ? response(result()) : pending.promise,
  );
  await flush();
  h.click('#statsLine [data-type="word"]');
  assert.equal(
    h.document.querySelector("#publicListTitle").textContent,
    "Word文档",
  );
  assert.equal(h.document.querySelector("#publicTable").hidden, true);
  assert.equal(h.document.querySelector("#pagination").hidden, true);
  assert.notEqual(
    h.document.querySelector("#publicListCount").textContent,
    "当前结果 1 条",
  );
  pending.reject(new Error("连接中断"));
  await flush();
  assert.match(
    h.document.querySelector("#emptyState").textContent,
    /资源加载失败/,
  );
  assert.match(h.document.querySelector("#statsNote").textContent, /上次成功/);
  assert.equal(
    h.document.querySelector('#statsLine [aria-current="page"]').dataset.type,
    "word",
  );
  assert.equal(
    h.document.querySelector('#statsLine [data-count="all"]').textContent,
    "31",
  );
});

test("public stale success and stale errors cannot overwrite the current category", async () => {
  for (const rejected of [false, true]) {
    const old = deferred();
    let request = 0;
    const h = await harness(() =>
      ++request === 1
        ? old.promise
        : response(result([resource("PDF 当前资源", "pdf")])),
    );
    h.click('#statsLine [data-type="pdf"]');
    await flush();
    if (rejected) old.reject(new Error("旧错误"));
    else old.resolve(response(result([resource("旧 HTML 资源")])));
    await flush();
    assert.match(
      h.document.querySelector("#docRows").textContent,
      /PDF 当前资源/,
    );
    assert.doesNotMatch(
      h.document.querySelector("#docRows").textContent,
      /旧 HTML/,
    );
    assert.equal(h.document.querySelector("#emptyState").hidden, true);
    assert.equal(h.document.querySelector("#publicLoading").hidden, true);
  }
});

test("public empty library, empty category and empty search expose distinct recovery actions", async () => {
  const cases = [
    ["/", { all: 0, html: 0, pdf: 0, word: 0 }, "暂无公开资源", null],
    [
      "/type/pdf",
      { all: 1, html: 1, pdf: 0, word: 0 },
      "暂无 PDF文档",
      "[data-all]",
    ],
    [
      "/type/pdf?q=不存在",
      { all: 1, html: 1, pdf: 0, word: 0 },
      "没有匹配的资源",
      "[data-clear]",
    ],
  ];
  for (const [url, stats, text, button] of cases) {
    const h = await harness(async () => response(result([], { stats })), url);
    await flush();
    assert.match(
      h.document.querySelector("#emptyState").textContent,
      new RegExp(text),
    );
    if (button) {
      h.click(`#emptyState ${button}`);
      await flush();
      assert.equal(h.location.pathname, "/");
    } else assert.equal(h.document.querySelector("#emptyState button"), null);
    assert.equal(h.document.querySelector("#publicTable").hidden, true);
  }
});

test("public resource rows expose four columns, date-only updates and native reading links around their metadata", async () => {
  const page = {
    ...resource('<img src=x onerror="bad()"> & 报告', "word"),
    directoryName: "",
    fileName: "<b>报告.docx</b>",
  };
  const h = await harness(async () => response(result([page])));
  await flush();
  const rows = h.document.querySelector("#docRows");
  assert.equal(rows.querySelector("img, b"), null);
  assert.deepEqual(
    [...h.document.querySelectorAll(".doc-table th")].map((th) => th.textContent.trim()),
    ["资源名称", "更新日期", "类型", "操作"],
  );
  assert.equal(rows.querySelectorAll("td").length, 4);
  assert.match(rows.textContent, /2 KB/);
  assert.equal(rows.querySelector(".resource-type").textContent, "Word");
  const rowLink = rows.querySelector(".resource-row-link");
  assert.equal(rowLink.querySelector(".title-main").textContent, page.title);
  assert.equal(rowLink.querySelector(".resource-file-name").textContent, page.fileName);
  for (const a of rows.querySelectorAll("a")) {
    assert.equal(a.getAttribute("href"), page.url);
    assert.equal(a.getAttribute("target"), "_blank");
    assert.match(a.getAttribute("rel"), /noopener/);
    assert.match(a.getAttribute("aria-label"), /新标签页/);
  }
  assert.equal(
    rows.querySelector(".resource-time").textContent,
    "2025-10-09",
  );
  const select = h.document.querySelector("#sortSelect");
  select.value = "created_desc";
  select.onchange({ target: select });
  await flush();
  assert.equal(
    h.document.querySelector("#timeHeading").textContent,
    "更新日期",
  );
  assert.equal(
    rows.querySelector(".resource-time").textContent,
    "2025-10-09",
  );
});

test("public counts compact large metrics with complete visible values and handle real zero", async () => {
  const h = await harness(async () =>
    response(
      result([], {
        stats: { all: 123456789, html: 123456789, pdf: 0, word: 0 },
      }),
    ),
  );
  await flush();
  assert.equal(
    h.document.querySelector('#statsLine [data-count="all"]').textContent,
    "1.2亿",
  );
  assert.match(
    h.document.querySelector('#statsLine [data-type="all"] small').textContent,
    /123,456,789/,
  );
  assert.equal(
    h.document.querySelector("#allDocumentsLink").textContent,
    "全部文档",
  );
  assert.equal(
    h.document.querySelector('#statsLine [data-count="pdf"]').textContent,
    "0",
  );
});

test("public retry and browser history restore the current URL without duplicate entries or pending search", async () => {
  let request = 0;
  const h = await harness(() =>
    ++request === 1 ? response({ error: "暂时失败" }, 503) : response(result()),
  );
  await flush();
  h.click("#emptyState [data-retry]");
  await flush();
  assert.equal(h.historyCalls.length, 0);
  assert.equal(h.document.querySelector("#publicTable").hidden, false);
  await h.input("待提交关键词");
  await h.navigate("/type/word?q=恢复&sort=created_desc");
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.document.querySelector("#searchInput").value, "恢复");
  assert.equal(
    h.document.querySelector('#statsLine [aria-current="page"]').dataset.type,
    "word",
  );
  assert.equal(h.historyCalls.length, 0);
});

test("public loading announces progress outside the busy results panel", async () => {
  const pending = deferred();
  const h = await harness(() => pending.promise);
  const status = h.document.querySelector("#resultStatus");
  assert.equal(
    h.document.querySelector(".resource-panel").getAttribute("aria-busy"),
    "true",
  );
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.match(status.textContent, /正在加载全部文档/);
  assert.ok(
    !status.closest('[aria-busy="true"]'),
    "loading announcements must remain outside busy ancestors",
  );
  pending.resolve(response(result()));
  await flush();
  assert.match(status.textContent, /共 1 条/);
  assert.equal(
    h.document.querySelector(".resource-panel").hasAttribute("aria-busy"),
    false,
  );
});

test("public keyboard pagination retains an enabled continuation across rebuilt pages", async () => {
  const pending = [];
  let request = 0;
  const h = await harness(() => {
    if (++request === 1) return response(result([resource()], { total: 21 }));
    const next = deferred();
    pending.push(next);
    return next.promise;
  });
  await flush();
  for (const page of [2, 3]) {
    const next = h.document.querySelector('#pagination [aria-label="下一页"]');
    next.focus();
    h.click(next);
    assert.ok(
      h.document.activeElement === h.document.querySelector("#publicListTitle"),
      "focus must move to the stable list heading before hiding the triggering action",
    );
    assert.equal(h.document.activeElement.closest("[hidden]"), null);
    pending.at(-1).resolve(response(result([resource()], { total: 21, page })));
    await flush();
    const focused = h.document.activeElement;
    assert.equal(focused.isConnected, true);
    assert.equal(focused.closest("[hidden]"), null);
    assert.equal(focused.disabled, false);
    assert.equal(
      focused.getAttribute("aria-label"),
      page === 2 ? "下一页" : "第 3 页",
    );
  }
});

test("public empty-category, empty-search and error recovery keep keyboard focus usable", async () => {
  for (const [url, initial, action] of [
    [
      "/type/pdf",
      response(result([], { stats: { all: 1, html: 1, pdf: 0, word: 0 } })),
      "data-all",
    ],
    ["/?q=不存在", response(result([])), "data-clear"],
    ["/", response({ error: "临时失败" }, 503), "data-retry"],
  ]) {
    const pending = deferred();
    let request = 0;
    const h = await harness(
      () => (++request === 1 ? initial : pending.promise),
      url,
    );
    await flush();
    const button = h.document.querySelector(`#emptyState [${action}]`);
    button.focus();
    h.click(button);
    assert.ok(
      h.document.activeElement === h.document.querySelector("#publicListTitle"),
      "focus must move to the stable list heading before hiding the triggering action",
    );
    assert.equal(h.document.activeElement.closest("[hidden]"), null);
    pending.resolve(response(result()));
    await flush();
    assert.ok(
      h.document.activeElement === h.document.querySelector("#publicTable"),
      "successful recovery must focus the visible results",
    );
  }

  let request = 0;
  const h = await harness(
    () =>
      response(
        ++request === 1 ? result([]) : { error: "仍然失败" },
        request === 1 ? 200 : 503,
      ),
    "/?q=不存在",
  );
  await flush();
  h.document.querySelector("[data-clear]").focus();
  h.click("[data-clear]");
  await flush();
  assert.ok(
    h.document.activeElement === h.document.querySelector("[data-retry]"),
    "failed recovery must focus its new retry action",
  );
});

test("public async recovery preserves newer input or category focus and ignores superseded requests", async () => {
  for (const superseded of [false, true]) {
    const old = deferred();
    let request = 0;
    const h = await harness(() =>
      ++request === 1
        ? response(result([resource()], { total: 21 }))
        : request === 2
          ? old.promise
          : response(result()),
    );
    await flush();
    const next = h.document.querySelector('#pagination [aria-label="下一页"]');
    next.focus();
    h.click(next);
    let expected;
    if (superseded) {
      expected = h.document.querySelector('#statsLine [data-type="pdf"]');
      expected.focus();
      h.click(expected);
      await flush();
    } else {
      await h.input("继续输入");
      expected = h.document.querySelector("#searchInput");
    }
    old.resolve(response(result([resource()], { total: 21, page: 2 })));
    await flush();
    assert.ok(
      h.document.activeElement === expected,
      "request completion must preserve newer user focus",
    );
  }
});


test("public root defaults to search home with six recent documents and independent global counts", async () => {
  const h = await harness(undefined, "/");
  await flush();
  assert.equal(h.document.querySelector("#homeHero").hidden, false);
  assert.equal(h.document.querySelector("#homeGuide").hidden, false);
  assert.equal(h.document.querySelector("#publicListToolbar").hidden, true);
  assert.equal(h.document.querySelector("#publicListTitle").textContent, "最近更新");
  assert.equal(h.document.querySelector("#pagination").hidden, true);
  assert.equal(h.document.querySelector("#publicHomeLink").getAttribute("aria-current"), "page");
  assert.equal(h.document.querySelector('#statsLine [aria-current="page"]'), null);
  const params = new URL(h.calls[0], h.location).searchParams;
  assert.equal(params.get("pageSize"), "6");
  assert.equal(params.get("sort"), "updated_desc");
  assert.equal(params.get("q"), "");
  assert.equal(h.location.search, "");
  assert.equal(h.historyCalls.length, 0);
});

test("home search submits once into the existing list and survives refresh and history", async () => {
  const h = await harness(undefined, "/");
  await flush();
  const input = h.document.querySelector("#homeSearchInput");
  input.value = "  年度 & 指南  ";
  input.focus();
  h.document.querySelector("#homeSearch").onsubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.document.querySelector("#homeHero").hidden, true);
  assert.equal(h.document.querySelector("#searchInput").value, "年度 & 指南");
  assert.equal(h.location.search.includes("view=resources"), true);
  const params = new URL(h.calls[1], h.location).searchParams;
  assert.equal(params.get("q"), "年度 & 指南");
  assert.equal(params.get("pageSize"), "10");
  assert.equal(h.document.activeElement.closest("[hidden]"), null);
  const refreshed = await harness(undefined, h.location.pathname + h.location.search);
  await flush();
  assert.equal(refreshed.document.querySelector("#homeHero").hidden, true);
  await h.navigate("/");
  assert.equal(h.document.querySelector("#homeHero").hidden, false);
  assert.equal(h.document.querySelector("#homeSearchInput").value, "");
  assert.equal(new URL(h.calls.at(-1), h.location).searchParams.get("pageSize"), "6");
});

test("home category links use draft keywords while view-all opens the complete resource list", async () => {
  const h = await harness(undefined, "/");
  await flush();
  const input = h.document.querySelector("#homeSearchInput");
  input.value = "项目资料";
  input.oninput();
  const link = h.document.querySelector('#statsLine [data-type="html"]');
  assert.equal(new URL(link.getAttribute("href"), h.location).searchParams.get("q"), "项目资料");
  const native = h.click(link, { ctrlKey: true });
  assert.equal(native.prevented, undefined);
  assert.equal(h.calls.length, 1);
  h.click(link);
  await flush();
  assert.equal(h.location.pathname, "/type/html");
  assert.equal(h.document.querySelector("#homeHero").hidden, true);
  h.click("#publicHomeLink");
  await flush();
  input.value = "未提交草稿";
  input.oninput();
  h.click("#homeViewAll");
  await flush();
  assert.equal(h.location.search, "?view=resources");
  assert.equal(new URL(h.calls.at(-1), h.location).searchParams.get("q"), "");
});

test("pending list search cannot replay after returning home and late results cannot replace home recommendations", async () => {
  const pending = deferred();
  let request = 0;
  const h = await harness(() => ++request === 2 ? pending.promise : response(result([resource("最近更新推荐")])));
  await flush();
  await h.input("旧搜索");
  await h.tick();
  h.click("#publicHomeLink");
  await flush();
  pending.resolve(response(result([resource("旧搜索结果")])));
  await flush();
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.document.querySelector("#publicListTitle").textContent, "最近更新");
  assert.match(h.document.querySelector("#docRows").textContent, /最近更新推荐/);
  assert.doesNotMatch(h.document.querySelector("#docRows").textContent, /旧搜索结果/);
});

test("home failure keeps search available and retries its recent-documents query", async () => {
  let request = 0;
  const h = await harness(() => ++request === 1 ? response({error:"offline"},503) : response(result()), "/");
  await flush();
  assert.equal(h.document.querySelector("#homeHero").hidden, false);
  assert.match(h.document.querySelector("#emptyState").textContent, /资源加载失败/);
  h.document.querySelector("#homeSearchInput").value = "未提交关键词";
  h.click("#emptyState [data-retry]");
  await flush();
  assert.equal(new URL(h.calls.at(-1), h.location).searchParams.get("q"), "", "retry must keep recommendations independent of an unsubmitted search");
  assert.equal(new URL(h.calls.at(-1), h.location).searchParams.get("pageSize"), "6");
  assert.equal(h.document.querySelector("#publicTable").hidden, false);
  assert.equal(h.document.querySelector("#pagination").hidden, true);
});


test("an empty home search opens the complete list with a refreshable URL", async () => {
  const h = await harness(undefined, "/");
  await flush();
  h.document.querySelector("#homeSearchInput").value = "   ";
  h.document.querySelector("#homeSearch").onsubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.location.search, "?view=resources");
  assert.equal(h.document.querySelector("#homeHero").hidden, true);
  assert.equal(new URL(h.calls.at(-1), h.location).searchParams.get("pageSize"), "10");
  assert.equal(new URL(h.calls.at(-1), h.location).searchParams.get("q"), "");
});

test("top all-documents link clears drafts, sort and paging and preserves native modified clicks", async () => {
  const h = await harness(undefined, "/type/pdf?q=old&sort=created_desc&page=2");
  await flush();
  assert.equal(h.document.querySelector(".shell-sidebar, #sidebarToggle, #sidebarResizer"), null);
  assert.equal(h.document.querySelector("#publicHomeLink").getAttribute("href"), "/");
  const native = h.click("#allDocumentsLink", { ctrlKey: true });
  assert.equal(native.prevented, undefined);
  const before = h.calls.length;
  await h.input("尚未搜索");
  h.click("#allDocumentsLink");
  await flush();
  await h.tick();
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.location.pathname + h.location.search, "/?view=resources");
  assert.equal(h.document.querySelector("#searchInput").value, "");
  assert.equal(h.document.querySelector("#sortSelect").value, "updated_desc");
  assert.equal(h.document.querySelector("#allDocumentsLink").getAttribute("aria-current"), "page");
});

test("responsive navigation retains keyboard focus when more or its links move between layouts", async () => {
  const h = await harness(undefined, "/", { viewportWidth: 375, width: 160 });
  await flush();
  const more = h.document.querySelector("#publicNavMore");
  const summary = more.querySelector("summary");
  const guide = h.document.querySelector('[data-nav-id="guide"]');
  assert.equal(guide.parentElement.id, "publicNavOverflow");
  summary.focus();
  h.resize(1440, 800);
  assert.equal(more.hidden, true);
  assert.equal(h.document.activeElement.id, "allDocumentsLink");
  h.resize(375, 160);
  more.open = true;
  guide.focus();
  h.resize(1440, 800);
  assert.equal(guide.parentElement.id, "publicNavLinks");
  assert.equal(h.document.activeElement, guide);
  h.resize(375, 160);
  assert.equal(more.hidden, false);
  assert.equal(h.document.activeElement, summary);
});

test("custom navigation compares canonical page state across query order, encoding and defaults", async () => {
  for (const [menu, current, selected] of [
    ["/?view=resources&q=团队 资料&sort=updated_desc&page=1", "/?q=团队+资料&view=resources", true],
    ["/type/html/?sort=updated_desc&q=团队", "/type/html?q=%E5%9B%A2%E9%98%9F", true],
    ["https://elsewhere.test/?view=resources&q=团队", "/?q=团队&view=resources", false],
    ["/unrelated-document", "/", false],
  ]) {
    const h = await harness(undefined, current, { viewportWidth: 1440, width: 800, guideUrl: menu });
    await flush();
    assert.equal(h.document.querySelector('[data-nav-id="guide"]').getAttribute("aria-current"), selected ? "page" : null, menu);
  }
});
