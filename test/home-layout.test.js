import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { paginationHtml as renderPagination } from "../public/ui.js";

async function appHarness(fetchImpl, pathname = "/admin", timers = {}) {
  const initialUrl = new URL(pathname, "http://test");
  const location = { pathname: initialUrl.pathname, search: initialUrl.search, hash: initialUrl.hash, origin: initialUrl.origin, href: initialUrl.href, assign() {} };
  const updateLocation = (url) => {
    const next = new URL(url, location.href);
    Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash, href: next.href });
  };
  const { document, window } = parseHTML(
    await fs.readFile("public/index.html", "utf8"),
  );
  const listeners = new Map();
  let analyticsClick;
  const analyticsView = document.querySelector("#rankingDetailsPager");
  const addAnalyticsListener = analyticsView.addEventListener.bind(analyticsView);
  analyticsView.addEventListener = (type, listener, options) => {
    if (type === "click") analyticsClick = listener;
    addAnalyticsListener(type, listener, options);
  };
  const addEventListener = window.addEventListener.bind(window);
  window.addEventListener = (type, listener, options) => {
    listeners.set(type, listener);
    addEventListener(type, listener, options);
  };
  const proto = window.HTMLElement.prototype;
  proto.focus = function () {};
  proto.scrollIntoView = function () {};
  proto.getBoundingClientRect = () => ({ left: 0, right: 0 });
  proto.reportValidity = () => true;
  proto.showModal = function () {
    this.setAttribute("open", "");
  };
  proto.close = function () {
    this.removeAttribute("open");
  };
  Object.defineProperty(proto, "open", {
    configurable: true,
    get() {
      return this.hasAttribute("open");
    },
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, "options", {
    configurable: true,
    get() {
      return [...this.querySelectorAll("option")];
    },
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() {
      return (
        this.options.find((o) => o.selected)?.value ||
        this.options[0]?.value ||
        ""
      );
    },
    set(value) {
      this.options.forEach((o) => o.removeAttribute("selected"));
      this.options.find((o) => o.value === value)?.setAttribute("selected", "");
    },
  });
  const context = vm.createContext({
    document,
    window,
    location,
    history: {
      state: null,
      replaceState(s, title, url) { this.state = s; if (url) updateLocation(url); },
      pushState(s, title, url) { this.state = s; if (url) updateLocation(url); },
      back() {},
    },
    console,
    URL,
    URLSearchParams,
    Date,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    esc: String,
    icon: () => "",
    fileIcon: () => "",
    formatSize: String,
    formatDate: String,
    paginationHtml: renderPagination,
    getComputedStyle: () => ({ paddingLeft: "16px", paddingRight: "16px" }),
    ResizeObserver: class { observe() {} },
    initShell() {},
    toast() {},
    wireDialog() {},
    confirmAction: async () => true,
    openMenu() {},
    notice(el, message) {
      el.hidden = false;
      el.textContent = message;
    },
    CSS: { escape: String },
    ...timers,
    Option: function (label, value) {
      const option = document.createElement("option");
      option.textContent = label;
      option.value = value;
      return option;
    },
  });
  let source = (await fs.readFile("public/app.js", "utf8")).replace(
    /^import[\s\S]+?from ["']\.\/ui\.js\?v=\d+["'];\n/,
    "",
  );
  source = source.slice(0, source.lastIndexOf("(async () => {"));
  vm.runInContext(
    source +
      "\nglobalThis.testApp={openAccess,saveAccess,closeAccess,uploadReviewDocuments,startAuthenticated,loadList,showLogin,api,saveSettings,queryString,clearFilters,openPreview,renderVersions,restoreVersion,hidePreview,mutatePage,cancelUpload,confirmUpload,renderUploadReview,uploadWithProgress,addSamples,addWatchDir,reloadWatchDirs,setUpload(value){stagedUpload=value;},getUpload(){return stagedUpload;},setPages(value){pages=value;},setSession(value){session=value;},setPreview(page){previewPage=page;},setFilters(value){filters={...filters,...value};}};",
    context,
  );
  return {
    document,
    window,
    app: context.testApp,
    location,
    clickRanking: target => analyticsClick({ target }),
    navigateHash(hash) {
      updateLocation(location.pathname + location.search + hash);
      return listeners.get("popstate")();
    },
    navigate(search) {
      context.location.search = search;
      return listeners.get("popstate")();
    },
  };
}
const listResult = {
  pages: [],
  stats: {},
  facets: { directories: [] },
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
};
const response = (value, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});

test("a dismissed confirmation cannot approve an earlier destructive operation later", async () => {
  const { document, window } = parseHTML(
    '<dialog id="confirmDialog"><h2></h2><p></p><button data-confirm-submit>Confirm</button><button data-confirm-cancel>Cancel</button></dialog>',
  );
  const dialog = document.querySelector("dialog");
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
    dialog.dispatchEvent(new window.Event("close"));
  };
  const source = (await fs.readFile("public/ui.js", "utf8")).replace(
    /^export /gm,
    "",
  );
  const context = vm.createContext({ document });
  vm.runInContext(source + "\nglobalThis.confirm = confirmAction;", context);
  let firstResult;
  const first = context
    .confirm({ title: "Delete A", message: "A" })
    .then((value) => {
      firstResult = value;
    });
  dialog.close();
  await Promise.resolve();
  assert.equal(
    firstResult,
    false,
    "programmatic close must cancel the old confirmation",
  );
  const second = context.confirm({ title: "Delete B", message: "B" });
  document.querySelector("[data-confirm-submit]").click();
  assert.equal(await second, true);
  await first;
  assert.equal(firstResult, false);
});

test("a slow detail response cannot replace a newer reader selection", async () => {
  let resolveA;
  const { document, app } = await appHarness(
    () =>
      new Promise((resolve) => {
        resolveA = resolve;
      }),
  );
  app.setSession(true);
  const a = {
    id: "A",
    title: "A title",
    fileType: "html",
    url: "/aaaaaa",
    canEdit: true,
  };
  const b = { ...a, id: "B", title: "B title", url: "/bbbbbb" };
  app.setPages([b]);
  const openingA = app.openPreview("A", false);
  await app.openPreview("B");
  resolveA(response({ page: a }));
  await openingA;
  assert.equal(document.querySelector("#previewTitle").textContent, "B title");
  assert.equal(
    document.querySelector("#previewFrame").getAttribute("src"),
    "/bbbbbb",
  );
  assert.equal(app.queryString().get("preview"), "B");
});

test("an earlier versions failure cannot overwrite the next document versions", async () => {
  let rejectA,
    resolveB,
    call = 0;
  const { document, app } = await appHarness(() =>
    ++call === 1
      ? new Promise((resolve, reject) => {
          rejectA = reject;
        })
      : new Promise((resolve) => {
          resolveB = resolve;
        }),
  );
  const host = document.querySelector("#historyList");
  const a = app.renderVersions({ id: "A" }, host),
    b = app.renderVersions({ id: "B" }, host);
  resolveB(response({ versions: [] }));
  await b;
  assert.match(host.textContent, /暂无历史版本/);
  rejectA(new Error("Old A error"));
  await a;
  assert.match(host.textContent, /暂无历史版本/);
  assert.doesNotMatch(host.textContent, /Old A error/);
});

test("deleting the current reader returns to the list with no stale document controls", async () => {
  const page = {
    id: "A",
    title: "A",
    fileType: "html",
    url: "/aaaaaa",
    canEdit: true,
  };
  const { document, app } = await appHarness(async (url, options = {}) =>
    response(
      options.method === "DELETE"
        ? { page: { ...page, deletedAt: new Date().toISOString() } }
        : listResult,
    ),
  );
  app.setSession(true);
  app.setPages([page]);
  await app.openPreview("A");
  await app.mutatePage(page, "delete");
  assert.equal(document.querySelector("#previewView").hidden, true);
  assert.equal(document.querySelector("#managerView").hidden, false);
  assert.equal(
    document.querySelector("#previewFrame").hasAttribute("src"),
    false,
  );
  assert.equal(app.queryString().get("preview"), null);
});

test("refreshing the list preserves the active reader view", async () => {
  const { document, app } = await appHarness(async () => response(listResult));
  app.setSession(true);
  app.setPreview({ id: "A" });
  document.querySelector("#managerView").hidden = true;
  document.querySelector("#previewView").hidden = false;
  await app.loadList();
  assert.equal(document.querySelector("#managerView").hidden, true);
  assert.equal(document.querySelector("#previewView").hidden, false);
});

test("session expiry releases native modals while preserving upload review inputs", async () => {
  const { document, app } = await appHarness(async () =>
    response({ error: "Unauthorized" }, 401),
  );
  const upload = document.querySelector("#uploadBackdrop");
  upload.showModal();
  const input = document.createElement("input");
  input.value = "Unsaved review";
  document.querySelector("#uploadReviewRows").append(input);
  document.querySelector("#historyDialog").showModal();
  await assert.rejects(app.api("/api/pages"), /Unauthorized/);
  assert.equal(upload.open, false);
  assert.equal(document.querySelector("#historyDialog").open, false);
  assert.equal(document.querySelector("#loginBackdrop").hidden, false);
  assert.equal(input.value, "Unsaved review");
});

test("initialization failure retries metadata and prevents saving unloaded settings", async () => {
  let fail = true,
    settingsCalls = 0;
  const { document, app } = await appHarness(async (url) => {
    if (url.endsWith("/api/settings")) {
      settingsCalls++;
      if (fail) throw new Error("Metadata offline");
      return response({
        settings: { siteName: "Loaded site", adminPath: "/admin" },
        runtime: { generatedDir: "/real/pages", autosaveDelayMs: 600 },
      });
    }
    if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
    return response(listResult);
  }, "/admin/settings");
  await app.startAuthenticated();
  assert.equal(document.querySelector("#saveSettings").disabled, true);
  assert.equal(document.querySelector("#saveSettingsTop").disabled, true);
  fail = false;
  document
    .querySelector("#globalError")
    .onclick({ target: { closest: () => true } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(settingsCalls, 2);
  assert.equal(document.querySelector("#siteNameInput").value, "Loaded site");
  assert.equal(document.querySelector("#saveSettings").disabled, false);
});

test("free text query and directory values are not mistaken for another filters default", async () => {
  const { app } = await appHarness(async () => response(listResult));
  for (const value of ["all", "active", "updated_desc"]) {
    app.setFilters({ q: value, directory: value });
    const query = app.queryString();
    assert.equal(query.get("q"), value);
    assert.equal(query.get("directory"), value);
  }
});

test("settings edits made during a pending save remain unsaved and visible", async () => {
  let resolveSave;
  const initial = {
    siteName: "Initial",
    adminPath: "/admin",
    authUsername: "admin",
  };
  const { document, window, app } = await appHarness(
    async (url, options = {}) => {
      if (options.method === "PATCH")
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      if (url.endsWith("/api/settings"))
        return response({ settings: initial, runtime: {} });
      if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
      return response(listResult);
    },
    "/admin/settings",
  );
  await app.startAuthenticated();
  const input = document.querySelector("#siteNameInput");
  input.value = "Submitted";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const saving = app.saveSettings({ preventDefault() {} });
  input.value = "New unsaved draft";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  resolveSave(response({ settings: { ...initial, siteName: "Submitted" } }));
  await saving;
  assert.equal(input.value, "New unsaved draft");
  assert.equal(
    document.querySelector("#settingsSaveState").textContent,
    "有未保存修改",
  );
  assert.equal(document.querySelector("#saveSettings").disabled, false);
});

test("clearing filters cancels an earlier debounced search even when the refresh is slow", async () => {
  const pending = new Map();
  let id = 0;
  const { document, app } = await appHarness(
    () => new Promise(() => {}),
    "/admin",
    {
      setTimeout(fn) {
        pending.set(++id, fn);
        return id;
      },
      clearTimeout(key) {
        pending.delete(key);
      },
    },
  );
  app.setSession(true);
  const input = document.querySelector("#searchInput");
  input.value = "Old keyword";
  input.oninput();
  app.clearFilters();
  for (const callback of pending.values()) callback();
  assert.equal(input.value, "");
  assert.equal(app.queryString().get("q"), null);
});

test("a custom management path named settings stays a manager route", async () => {
  const urls = [];
  const { document, app } = await appHarness(async (url) => {
    urls.push(url);
    if (url.endsWith("/api/settings"))
      return response({ settings: { adminPath: "/settings" }, runtime: {} });
    if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
    return response(listResult);
  }, "/settings");
  await app.startAuthenticated();
  assert.equal(urls[0], "/settings/api/settings");
  assert.equal(document.querySelector("#settingsPage").hidden, true);
});

async function documentAt(file) {
  return parseHTML(await fs.readFile(path.resolve(file), "utf8")).document;
}

async function settleUntil(predicate) {
  for (let i = 0; i < 30 && !predicate(); i++) await Promise.resolve();
  assert.ok(
    predicate(),
    "expected asynchronous operation to reach its checkpoint",
  );
}

for (const [dependencyId, fieldId, enabled, restored] of [
  ["remoteSyncEnabledInput", "remoteSyncUrlInput", true, false],
  ["adminPathInput", "currentPasswordInput", "/operations", "/admin"],
]) {
  test(`settings conditional requirement follows ${dependencyId} before native submit validation`, async () => {
    let saves = 0;
    const initial = { adminPath: "/admin", siteName: "Test" };
    const { document, window, app } = await appHarness(
      async (url, options = {}) => {
        if (options.method === "PATCH") saves++;
        if (url.endsWith("/api/settings"))
          return response({ settings: initial, runtime: {} });
        if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
        return response(listResult);
      },
      "/admin/settings",
    );
    await app.startAuthenticated();
    const dependency = document.getElementById(dependencyId);
    const field = document.getElementById(fieldId);
    const property = typeof enabled === "boolean" ? "checked" : "value";
    dependency[property] = enabled;
    dependency.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(
      field.required,
      true,
      "the field becomes required before the browser checks the form",
    );
    dependency[property] = restored;
    dependency.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(
      field.required,
      false,
      "reverting the option must release the native validation gate",
    );
    await app.saveSettings({ preventDefault() {} });
    assert.equal(saves, 1);
  });
}

test("upload cancellation serializes every close entry and blocks confirmation until cleanup finishes", async () => {
  const requests = [];
  const { document, app } = await appHarness(
    (url, options = {}) =>
      new Promise((resolve) => requests.push({ url, ...options, resolve })),
  );
  app.setSession(true);
  app.setUpload({ uploadId: "A" });
  document.querySelector("#uploadBackdrop").showModal();
  const first = app.cancelUpload();
  const second = document.querySelector("#closeUpload").onclick();
  const confirming = app.confirmUpload();
  assert.equal(
    requests.length,
    1,
    "repeated close must not issue another cleanup or commit request",
  );
  assert.equal(requests[0].method, "DELETE");
  for (const id of ["cancelUpload", "closeUpload", "confirmUpload"])
    assert.equal(document.getElementById(id).disabled, true, id);
  requests[0].resolve(response({}, 204));
  await first;
  await confirming;
  app.setUpload({ uploadId: "B" });
  document.querySelector("#uploadReviewRows").innerHTML =
    '<input value="B draft">';
  document.querySelector("#uploadBackdrop").showModal();
  await second;
  assert.equal(app.getUpload().uploadId, "B");
  assert.equal(
    document.querySelector("#uploadReviewRows input").value,
    "B draft",
  );
  assert.equal(document.querySelector("#uploadBackdrop").open, true);
});

test("failed upload cleanup preserves the batch and allows a single retry", async () => {
  let calls = 0;
  const { document, app } = await appHarness(async () =>
    response({ error: "Cleanup offline" }, ++calls === 1 ? 500 : 204),
  );
  app.setUpload({ uploadId: "A" });
  document.querySelector("#uploadBackdrop").showModal();
  document.querySelector("#uploadReviewRows").innerHTML =
    '<input value="A draft">';
  await app.cancelUpload();
  assert.equal(app.getUpload().uploadId, "A");
  assert.equal(document.querySelector("#uploadBackdrop").open, true);
  assert.equal(document.querySelector("#cancelUpload").disabled, false);
  assert.match(
    document.querySelector("#uploadProgressText").textContent,
    /清理失败/,
  );
  await app.cancelUpload();
  assert.equal(calls, 2);
  assert.equal(app.getUpload(), null);
  assert.equal(document.querySelector("#uploadBackdrop").open, false);
});

test("partial upload conversion failure requires verification and cannot replay the entire batch", async () => {
  let commits = 0;
  const { document, app } = await appHarness(async () => {
    commits++;
    return response({ error: "Word conversion failed after HTML import" }, 422);
  });
  const upload = {
    uploadId: "mixed",
    documents: [
      {
        id: "html",
        fileType: "html",
        relativePath: "a.html",
        fileName: "a.html",
        title: "A",
      },
    ],
    assetCount: 0,
  };
  app.setUpload(upload);
  app.renderUploadReview(upload);
  await app.confirmUpload();
  await app.confirmUpload();
  assert.equal(
    commits,
    1,
    "a partially committed batch must not be submitted twice",
  );
  assert.equal(document.querySelector("#confirmUpload").disabled, true);
  assert.equal(document.querySelector("#verifyUpload").hidden, false);
  assert.equal(
    document.querySelector('[data-upload-field="title"]').value,
    "A",
  );
});

test("successful upload keeps the result on the current page and clears password drafts without replay", async () => {
  const requests = [];
  const page = { id: "A", title: "产品发布方案", fileName: "launch.html", url: "/abc123", visibility: "public", homepageListed: false, hasAccessPassword: true };
  const { document, app, location } = await appHarness(async (url, options = {}) => {
    requests.push({ url, method: options.method });
    return response(options.method === "POST" ? { pages: [page] } : { ...listResult, pagination: { ...listResult.pagination, page: 2, totalPages: 2 } });
  }, "/admin?view=documents&type=pdf&page=2");
  app.setSession(true);
  const upload = { uploadId: "A", documents: [{ ...page, fileType: "html" }] };
  app.setUpload(upload);
  app.renderUploadReview(upload);
  const row = document.querySelector("[data-upload-doc-id]");
  row.querySelector('[data-upload-field="protected"]').checked = true;
  row.querySelector('[data-upload-field="password"]').value = "draft-password";
  document.querySelector("#uploadBackdrop").showModal();
  await app.confirmUpload();
  await app.confirmUpload();
  assert.equal(requests.filter(request => request.method === "POST").length, 1);
  assert.equal(document.querySelector("#uploadBackdrop").open, true);
  assert.equal(document.querySelector("#uploadSuccess").hidden, false);
  assert.match(document.querySelector("#uploadSuccessTitle").textContent, /1 个文档/);
  assert.equal(document.querySelector("#uploadSuccessList a").getAttribute("href"), "/abc123");
  assert.match(document.querySelector("#uploadSuccessList").textContent, /仅链接 · 需要密码/);
  assert.equal(document.querySelector("#uploadReviewRows").childElementCount, 0);
  assert.equal(app.queryString().get("page"), "2");
  assert.equal(app.queryString().get("type"), "pdf");
  assert.equal(location.pathname, "/admin");
  await app.cancelUpload();
  assert.equal(document.querySelector("#uploadBackdrop").open, false);
  assert.equal(requests.filter(request => request.method === "DELETE").length, 0);
});

test("a failed list refresh preserves the successful upload and the next-upload entry", async () => {
  const { document, app } = await appHarness(async (url, options = {}) => {
    if (options.method === "POST") return response({ pages: [{ title: "A", fileName: "a.html", url: "/abc123" }] });
    throw new Error("Offline");
  });
  app.setSession(true);
  app.setUpload({ uploadId: "A" });
  document.querySelector("#uploadBackdrop").showModal();
  await app.confirmUpload();
  assert.equal(document.querySelector("#uploadSuccess").hidden, false);
  assert.match(document.querySelector("#uploadSuccessNote").textContent, /已成功入库.*刷新失败/);
  let picked = 0;
  document.querySelector("#fileInput").click = () => { picked++; };
  document.querySelector("#continueUpload").click();
  assert.equal(picked, 1);
  assert.equal(document.querySelector("#uploadBackdrop").open, false);
  assert.equal(app.getUpload(), null);
  assert.equal(document.querySelector("#uploadSuccessList").childElementCount, 0);
});

test("viewing uploaded documents explicitly leaves old filters and the trash scope", async () => {
  const { document, app } = await appHarness(async () => response(listResult), "/admin?scope=trash&type=pdf&q=old");
  app.setSession(true);
  document.querySelector("#uploadBackdrop").showModal();
  document.querySelector("#viewUploadedDocuments").click();
  assert.equal(document.querySelector("#uploadBackdrop").open, false);
  assert.equal(app.queryString().get("view"), "documents");
  for (const key of ["q", "type", "scope", "page"]) assert.equal(app.queryString().has(key), false, key);
});

for (const destination of ["?view=documents", "?preview=B"]) {
  test(`history navigation reconciles ${destination || "the list"} even when the list request fails`, async () => {
    const reading = destination.includes("preview=");
    const a = {
      id: "A",
      title: "A",
      fileType: "html",
      url: "/aaaaaa",
      canEdit: true,
    };
    const b = { ...a, id: "B", title: "B", url: "/bbbbbb" };
    let fail = true;
    const { document, app, navigate } = await appHarness(async (url) => {
      if (url.endsWith("/api/pages/B")) return response({ page: b });
      return fail
        ? response({ error: "List offline" }, 500)
        : response(listResult);
    });
    app.setSession(true);
    app.setPages([a]);
    await app.openPreview("A");
    await navigate(destination);
    assert.equal(document.querySelector("#previewView").hidden, !reading);
    if (reading)
      assert.equal(document.querySelector("#previewTitle").textContent, "B");
    assert.match(
      document.querySelector("#globalError").textContent,
      /List offline/,
    );
    fail = false;
    await app.loadList();
    assert.equal(document.querySelector("#previewView").hidden, !reading);
    assert.equal(
      document.querySelector("#managerView").hidden,
      reading,
    );
  });
}

test("a failed restore reports only to the document whose version was restored", async () => {
  let finish;
  const { document, app } = await appHarness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  app.setSession(true);
  const page = { id: "A", title: "A" };
  app.setPreview(page);
  const host = document.querySelector("#previewVersions");
  host.innerHTML =
    '<button data-version="v1" data-version-page="A" data-revision="1">Restore A</button>';
  const restoring = app.restoreVersion(host.querySelector("button"));
  await settleUntil(() => finish);
  app.setPreview({ id: "B", title: "B" });
  host.innerHTML = "<p>B versions</p>";
  finish(response({ error: "A restore failed" }, 500));
  await restoring;
  assert.equal(host.textContent, "B versions");
  finish = null;
  app.setPreview(page);
  host.innerHTML =
    '<button data-version="v2" data-version-page="A" data-revision="2">Restore A</button>';
  const retrying = app.restoreVersion(host.querySelector("button"));
  await settleUntil(() => finish);
  finish(response({ error: "Current restore failed" }, 500));
  await retrying;
  assert.match(host.textContent, /Current restore failed/);
});

test("adding a watch directory preserves a newer path draft and ignores repeat submission while pending", async () => {
  let finish,
    posts = 0;
  const { document, app } = await appHarness(async (url, options = {}) => {
    if (options.method === "POST") {
      posts++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return response(
      url.endsWith("/watch-dirs") ? { watchDirs: [] } : listResult,
    );
  }, "/admin/settings");
  app.setSession(true);
  const input = document.querySelector("#watchDirInput");
  input.value = "/watch/A";
  const adding = app.addWatchDir();
  input.value = "/watch/B";
  const repeated = app.addWatchDir();
  assert.equal(posts, 1);
  finish(response({}));
  await adding;
  await repeated;
  assert.equal(input.value, "/watch/B");
  assert.equal(document.querySelector("#addWatchDirectory").disabled, false);
});

test("an old session 401 cannot revoke a newer authenticated session", async () => {
  let finish;
  const { document, app } = await appHarness(async (url) => {
    if (url.includes("old-session"))
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (url.endsWith("/api/settings"))
      return response({ settings: { adminPath: "/admin" }, runtime: {} });
    if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
    return response(listResult);
  });
  app.setSession(true);
  const old = app.api("/api/pages?old-session=1");
  app.showLogin("Expired");
  await app.startAuthenticated();
  finish(response({ error: "Unauthorized" }, 401));
  await assert.rejects(old, /Unauthorized/);
  assert.equal(document.body.dataset.auth, "authenticated");
  assert.equal(document.querySelector("#loginBackdrop").hidden, true);
});

test("metadata from a previous session cannot overwrite the current settings", async () => {
  const pending = [];
  let old = true;
  const { document, app } = await appHarness(async (url) => {
    if (url.endsWith("/api/settings") || url.endsWith("/api/watch-dirs")) {
      if (old) return new Promise((resolve) => pending.push({ url, resolve }));
      return response(
        url.endsWith("/api/settings")
          ? {
              settings: { adminPath: "/admin", siteName: "Current" },
              runtime: {},
            }
          : { watchDirs: [] },
      );
    }
    return response(listResult);
  }, "/admin/settings");
  const previous = app.startAuthenticated();
  await settleUntil(() => pending.length === 2);
  app.showLogin();
  old = false;
  await app.startAuthenticated();
  for (const request of pending)
    request.resolve(
      response(
        request.url.endsWith("/api/settings")
          ? {
              settings: { adminPath: "/admin", siteName: "Stale" },
              runtime: {},
            }
          : { watchDirs: [] },
      ),
    );
  await previous;
  assert.equal(document.querySelector("#siteNameInput").value, "Current");
  assert.equal(document.body.dataset.auth, "authenticated");
  assert.equal(document.querySelector("#saveSettings").disabled, false);
});

test("an old upload 401 cannot revoke a newer authenticated session", async () => {
  let xhr;
  const { document, app } = await appHarness(
    async (url) => {
      if (url.endsWith("/api/settings"))
        return response({ settings: { adminPath: "/admin" }, runtime: {} });
      return response(
        url.endsWith("/api/watch-dirs") ? { watchDirs: [] } : listResult,
      );
    },
    "/admin",
    {
      XMLHttpRequest: class {
        constructor() {
          xhr = this;
          this.upload = {};
        }
        open() {}
        send() {}
      },
    },
  );
  app.setSession(true);
  const previous = app.uploadWithProgress({});
  app.showLogin();
  await app.startAuthenticated();
  xhr.status = 401;
  xhr.responseText = JSON.stringify({ error: "Unauthorized" });
  xhr.onload();
  await assert.rejects(previous, /Unauthorized/);
  assert.equal(document.body.dataset.auth, "authenticated");
});

test("a previous session directory reload cannot bring removed directories back", async () => {
  let finish,
    old = true;
  const { document, app } = await appHarness(async (url) => {
    if (url.endsWith("/api/watch-dirs")) {
      if (old)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return response({ watchDirs: [] });
    }
    if (url.endsWith("/api/settings"))
      return response({ settings: { adminPath: "/admin" }, runtime: {} });
    return response(listResult);
  }, "/admin/settings");
  app.setSession(true);
  const previous = app.reloadWatchDirs();
  app.showLogin();
  old = false;
  await app.startAuthenticated();
  finish(
    response({
      watchDirs: [{ id: "removed", name: "Removed", path: "/watch/removed" }],
    }),
  );
  await previous;
  assert.match(
    document.querySelector("#watchList").textContent,
    /尚未添加监听目录/,
  );
  assert.doesNotMatch(
    document.querySelector("#watchList").textContent,
    /watch\/removed/,
  );
});
test("an earlier initialization cannot reopen an upload dialog after the current session dismissed it", async () => {
  let finish;
  const page = {
    id: "A",
    title: "A",
    fileType: "html",
    url: "/aaaaaa",
    canEdit: true,
  };
  const { document, app } = await appHarness(async (url) => {
    if (url.endsWith("/api/pages/A"))
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (url.endsWith("/api/settings"))
      return response({ settings: { adminPath: "/admin" }, runtime: {} });
    return response(
      url.endsWith("/api/watch-dirs") ? { watchDirs: [] } : listResult,
    );
  });
  app.setFilters({ preview: "A" });
  const previous = app.startAuthenticated();
  await settleUntil(() => finish);
  app.showLogin();
  app.setFilters({ preview: "" });
  app.setUpload({ uploadId: "uncertain-batch" });
  await app.startAuthenticated();
  const dialog = document.querySelector("#uploadBackdrop");
  dialog.close();
  finish(response({ page }));
  await previous;
  assert.equal(dialog.open, false);
  assert.equal(document.body.dataset.auth, "authenticated");
});

test("an earlier upload verification cannot close the next batch review", async () => {
  let finish;
  const { document, app } = await appHarness(async (url, options = {}) => {
    if (options.method === "POST")
      return response({ error: "Partial import" }, 422);
    if (options.method === "DELETE") return response({}, 204);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  app.setSession(true);
  app.setUpload({ uploadId: "A" });
  const dialog = document.querySelector("#uploadBackdrop");
  dialog.showModal();
  await app.confirmUpload();
  const verify = document.querySelector("#verifyUpload");
  const verifying = verify.onclick();
  await app.cancelUpload();
  app.setUpload({ uploadId: "B" });
  document.querySelector("#uploadReviewRows").innerHTML =
    '<input value="B draft">';
  dialog.showModal();
  finish(response(listResult));
  await verifying;
  assert.equal(dialog.open, true);
  assert.equal(app.getUpload().uploadId, "B");
  assert.equal(
    document.querySelector("#uploadReviewRows input").value,
    "B draft",
  );
});

test("a file chooser returning after session expiry cannot reopen a modal over login", async () => {
  let requests = 0;
  const { document, app } = await appHarness(async () => {
    requests++;
    return response({});
  });
  app.setSession(true);
  app.setUpload({ uploadId: "pending-A" });
  app.showLogin();
  document.querySelector("#fileInput").onchange({
    target: { files: [{ name: "new.html", size: 1 }], value: "new.html" },
  });
  assert.equal(document.querySelector("#uploadBackdrop").open, false);
  assert.equal(document.querySelector("#loginBackdrop").hidden, false);
  assert.equal(app.getUpload().uploadId, "pending-A");
  assert.equal(requests, 0);
});

for (const failRecoveryList of [false, true]) {
  test(`session recovery releases an earlier upload verification lock with list failure ${failRecoveryList}`, async () => {
    let finish,
      holdList = true,
      remainingFailures = failRecoveryList ? 1 : 0;
    const { document, app } = await appHarness(async (url, options = {}) => {
      if (options.method === "POST")
        return response({ error: "Partial import" }, 422);
      if (url.endsWith("/api/settings"))
        return response({ settings: { adminPath: "/admin" }, runtime: {} });
      if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
      if (holdList)
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (remainingFailures-- > 0)
        return response({ error: "Recovery list offline" }, 500);
      return response(listResult);
    });
    app.setSession(true);
    app.setUpload({ uploadId: "A" });
    document.querySelector("#uploadBackdrop").showModal();
    await app.confirmUpload();
    const verify = document.querySelector("#verifyUpload");
    const previous = verify.onclick();
    assert.equal(verify.disabled, true);
    app.showLogin();
    holdList = false;
    await app.startAuthenticated();
    finish(response(listResult));
    await previous;
    if (failRecoveryList)
      document
        .querySelector("#fileInput")
        .onchange({ target: { files: [], value: "" } });
    assert.equal(
      verify.disabled,
      false,
      "the old session no longer owns the verification lock",
    );
    assert.equal(document.querySelector("#uploadBackdrop").open, true);
    await verify.onclick();
    assert.equal(document.querySelector("#uploadBackdrop").open, false);
  });
}

test("manager exposes its supported workflows with labelled controls and isolated reading content", async () => {
  const doc = await documentAt("public/index.html");
  const ids = [
    "pickFiles",
    "pickDirectory",
    "uploadMore",
    "refreshList",
    "logoutButton",
    "editFromPreview",
    "copyFromPreview",
    "saveSettingsTop",
    "saveSettings",
    "addWatchDirectory",
    "closeUpload",
    "cancelUpload",
    "confirmUpload",
    "previewFrame",
    "historyDialog",
  ];
  for (const id of ids) assert.ok(doc.getElementById(id), id);
  assert.equal(doc.querySelector("#uploadBackdrop").tagName, "DIALOG");
  assert.equal(doc.querySelector("#confirmDialog").tagName, "DIALOG");
  assert.equal(
    doc.querySelector("#previewFrame").getAttribute("title"),
    "文档阅读内容",
  );
  assert.equal(doc.querySelector("#fileInput").getAttribute("multiple"), "");
  assert.match(
    doc.querySelector("#fileInput").getAttribute("accept"),
    /\.pdf.*\.doc/,
  );
  assert.ok(
    doc.querySelector("#directoryInput").hasAttribute("webkitdirectory"),
  );
  assert.ok(doc.querySelector("#settingsPage #watchList"));
  for (const id of [
    "siteNameInput",
    "adminNameInput",
    "publicHomepageEnabledInput",
    "publicSeoTitleInput",
    "publicSeoDescriptionInput",
    "publicSeoKeywordsInput",
    "trackingCodeInput",
    "remoteSyncEnabledInput",
    "remoteSyncUrlInput",
    "remoteSyncTokenInput",
    "authUsernameInput",
    "authPasswordInput",
    "adminPathInput",
    "currentPasswordInput",
  ])
    assert.ok(doc.querySelector(`#settingsPage #${id}`), id);
  assert.equal(
    doc.querySelector("#saveSettingsTop").getAttribute("form"),
    "settingsForm",
  );
  assert.equal(doc.querySelector("#previewFromEditor"), null);
  assert.equal(doc.querySelector("[data-command]"), null);
  const elements = [...doc.querySelectorAll("[id]")];
  assert.equal(
    new Set(elements.map((el) => el.id)).size,
    elements.length,
    "IDs are unique",
  );
  for (const script of doc.querySelectorAll("script[src]"))
    assert.equal(script.getAttribute("type"), "module");
});

test("public portal exposes reading controls, top navigation and no sidebar", async () => {
  const doc = await documentAt("public/index-public.html");
  for (const type of ["all", "html", "pdf", "word"])
    assert.ok(doc.querySelector(`[data-type="${type}"]`));
  for (const id of [
    "searchInput",
    "sortSelect",
    "docRows",
    "pagination",
    "clearFilters",
    "publicHomeLink",
    "allDocumentsLink",
    "publicNavigation",
  ])
    assert.ok(doc.getElementById(id), id);
  assert.equal(doc.querySelector(".shell-sidebar, #sidebarToggle, #sidebarResizer"), null);
  assert.equal(doc.querySelector("input[type=password]"), null);
  assert.equal(
    doc.querySelector("#sortSelect option[value=access_desc]"),
    null,
  );
  assert.ok(doc.querySelector('a[href*="github.com"]'));
  assert.ok(doc.querySelector('script[type=module][src*="public-app.js"]'));
});

test("sample entries share one pending request and recover after failure", async () => {
  let complete, posts = 0;
  const { document, app } = await appHarness((url, options) => {
    if (options?.method === "POST") {
      posts++;
      return new Promise((resolve) => { complete = resolve; });
    }
    return Promise.resolve(response(listResult));
  });
  app.setSession(true);
  await app.loadList();
  const more = document.querySelector("#uploadMore");
  const empty = document.querySelector("[data-empty-samples]");
  const prominent = document.querySelector("#uploadSamplesButton");
  assert.ok(prominent, "upload panel must provide a sample entry");
  const first = prominent.onclick({ currentTarget: prominent });
  const repeated = app.addSamples(empty);
  const another = app.addSamples(more);
  assert.equal(posts, 1, "other sample entries must not create a second batch");
  assert.equal(more.disabled, true);
  assert.equal(empty.disabled, true);
  assert.equal(prominent.disabled, true);
  complete(response({ error: "暂时不可用" }, 503));
  await Promise.all([first, repeated, another]);
  assert.equal(more.disabled, false);
  assert.equal(empty.disabled, false);
  const retry = app.addSamples(empty);
  assert.equal(posts, 2);
  complete(response({ pages: [] }));
  await retry;
  assert.equal(more.disabled, false);
  assert.equal(prominent.disabled, false);
  assert.equal(prominent.hasAttribute("aria-busy"), false);
});

test("prominent upload entries reuse the existing pickers and pending batch", async () => {
  let requests = 0;
  const { document, window, app } = await appHarness(() => { requests++; });
  app.setSession(true);
  let files = 0, directories = 0;
  document.querySelector("#fileInput").click = () => { files++; };
  document.querySelector("#directoryInput").click = () => { directories++; };
  const fileButton = document.querySelector("#uploadFilesButton");
  const directoryButton = document.querySelector("#uploadDirectoryButton");
  assert.ok(fileButton && directoryButton, "upload panel must provide both picker entries");
  fileButton.click();
  directoryButton.click();
  assert.equal(files, 1);
  assert.equal(directories, 1);
  app.setUpload({ uploadId: "pending-batch" });
  for (const selector of ["#uploadEntry", "#dropZone"]) {
    const drop = new window.Event("drop", { bubbles: true, cancelable: true });
    drop.dataTransfer = { files: [{ name: "new.html", size: 50 }] };
    document.querySelector(selector).dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(document.querySelector("#uploadBackdrop").open, true);
    assert.equal(app.getUpload().uploadId, "pending-batch");
    document.querySelector("#uploadBackdrop").close();
  }
  assert.equal(requests, 0, "a pending batch must not be replaced by another upload");
});

test('upload review keeps password and unlisted policy together and applies explicitly to a batch', async () => {
  const {document,app} = await appHarness(async () => response(listResult));
  app.setUpload({uploadId:'review-access'});
  app.renderUploadReview({documents:[{id:'a',title:'A',fileName:'a.html',fileType:'html'},{id:'b',title:'B',fileName:'b.html',fileType:'html'}]});
  const rows = [...document.querySelectorAll('[data-upload-doc-id]')];
  rows[0].querySelector('[data-upload-field="visibility"]').value='unlisted';
  rows[0].querySelector('[data-upload-field="protected"]').checked=true;
  rows[0].querySelector('[data-upload-field="password"]').value='  password  ';
  rows[0].querySelector('[data-apply-upload-policy]').click();
  const edits=app.uploadReviewDocuments();
  for (const edit of edits) { assert.equal(edit.homepageListed,false); assert.equal(edit.visibility,'public'); assert.equal(edit.passwordAction,'set'); assert.equal(edit.password,'  password  '); }
});

test('access settings keep an existing password without returning or submitting its original value', async () => {
  let policy;
  const {document,app}=await appHarness(async (url,options) => {
    if (String(url).endsWith('/access')) { policy=JSON.parse(options.body); return response({page:{id:'p',title:'Protected',visibility:'public',homepageListed:false,hasAccessPassword:true}}); }
    return response(listResult);
  });
  app.setSession(true);
  app.openAccess({id:'p',title:'Protected',visibility:'public',homepageListed:true,hasAccessPassword:true});
  assert.equal(document.querySelector('#accessPassword').value,'');
  document.querySelector('#accessMode').value='unlisted';
  await app.saveAccess({preventDefault(){}});
  assert.equal(policy.passwordAction,'keep'); assert.equal(policy.homepageListed,false); assert.equal(Object.hasOwn(policy,'password'),false);
  assert.equal(document.querySelector('#accessDialog').open,false);
});


const workspaceStats = { all: 8, editable: 3, todayCreated: 2, watchDirs: 1, trash: 1, byType: { html: 3, pdf: 2, word: 1, other: 2 } };
const workspaceFetch = async (url) => {
  if (url.endsWith("/api/settings")) return response({ settings: { adminPath: "/admin" }, runtime: {} });
  if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
  return response({ ...listResult, stats: workspaceStats });
};
const displayed = element => {
  for (let el = element; el; el = el.parentElement) if (el.hidden) return false;
  return true;
};

test("backend entry defaults to the independent upload workspace with shared statistics", async () => {
  const { document, app } = await appHarness(workspaceFetch);
  await app.startAuthenticated();
  assert.ok(displayed(document.querySelector("#uploadEntry")));
  assert.equal(displayed(document.querySelector("#dropZone")), false);
  assert.equal(document.querySelector("#workspaceTitle").textContent, "上传文档");
  assert.equal(document.querySelector("[data-nav-type]").dataset.navType, "upload");
  assert.equal(document.querySelector('[aria-current="page"]').dataset.navType, "upload");
  assert.equal(document.querySelector("#managerActions").hidden, true);
  for (const [id, value] of [["metricTotal", 8], ["metricEditable", 3], ["metricToday", 2], ["metricWatch", 1]]) {
    assert.ok(displayed(document.getElementById(id)));
    assert.equal(document.getElementById(id).textContent, String(value));
  }
});

test("upload, list and other-category history retain separate content and global metrics", async () => {
  const { document, app, navigate } = await appHarness(workspaceFetch);
  await app.startAuthenticated();
  for (const [url, upload, label] of [["?view=documents", false, "全部文档"], ["?type=html", false, "HTML文档"], ["?type=pdf", false, "PDF文档"], ["?type=word", false, "Word文档"], ["?type=other", false, "其它文档"], ["?scope=trash", false, "回收站"], ["", true, "上传文档"]]) {
    await navigate(url);
    assert.equal(displayed(document.querySelector("#uploadEntry")), upload, url);
    assert.equal(displayed(document.querySelector("#dropZone")), !upload, url);
    assert.equal(document.querySelector("[aria-current=page]").textContent.includes(label), true, url);
    assert.equal(document.querySelector("#metricTotal").textContent, "8");
    assert.ok(displayed(document.querySelector("#metricTotal")));
  }
  assert.equal(document.querySelector('[data-count="other"]').textContent, "2");
});

test("upload navigation clears list filters so reload keeps the upload page", async () => {
  const { document, window, app } = await appHarness(workspaceFetch, "/admin?type=other&q=secret&accessMode=unlisted&password=yes&page=4");
  await app.startAuthenticated();
  document.querySelector('[data-nav-type="upload"]').dispatchEvent(Object.assign(new window.Event("click", { cancelable: true }), { button: 0 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.queryString().size, 0);
  assert.equal(document.querySelector("#searchInput").value, "");
  assert.ok(displayed(document.querySelector("#uploadEntry")));
  await app.startAuthenticated();
  assert.ok(displayed(document.querySelector("#uploadEntry")));
});

test("direct list, reader, custom admin and settings routes keep shared statistics", async () => {
  for (const route of ["/admin?view=documents", "/admin?type=other", "/settings", "/admin/settings"]) {
    const { document, app } = await appHarness(workspaceFetch, route);
    await app.startAuthenticated();
    assert.ok(displayed(document.querySelector("#metricTotal")), route);
    assert.equal(document.querySelector("#metricTotal").textContent, "8");
    if (route === "/admin/settings") assert.equal(document.querySelector("#settingsPage").hidden, false);
    if (route === "/settings") assert.equal(document.querySelector('[data-nav-type="all"]').getAttribute("href"), "/settings?view=documents");
  }
  const { document, app } = await appHarness(workspaceFetch, "/admin?view=documents");
  await app.startAuthenticated();
  app.setPages([{ id: "reader", title: "Read", fileType: "html", url: "/reader", canEdit: true }]);
  await app.openPreview("reader");
  assert.ok(displayed(document.querySelector("#metricTotal")));
  assert.equal(displayed(document.querySelector("#uploadEntry")), false);
  assert.equal(document.querySelector("#previewView").hidden, false);
});


test("settings return-to-documents link opens the document list on custom admin paths", async () => {
  for (const route of ["/admin/settings", "/workspace/settings", "/settings/settings"]) {
    const { document, app } = await appHarness(workspaceFetch, route);
    await app.startAuthenticated();
    const base = route.slice(0, -9);
    assert.equal(document.querySelector("#settingsBackLink").getAttribute("href"), base + "?view=documents");
  }
});


async function settingsHarness({ hash = "", patch, upload, context = {} } = {}) {
  const requests = [];
  const initial = { adminPath: "/admin", siteName: "Test", adminName: "Test", authUsername: "admin" };
  const harness = await appHarness(async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url.endsWith("/api/brand/logo") && upload) return upload(options);
    if (options.method === "PATCH") return patch ? patch(JSON.parse(options.body)) : response({ settings: { ...initial, ...JSON.parse(options.body) } });
    if (url.endsWith("/api/settings")) return response({ settings: initial, runtime: {} });
    if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
    return response(listResult);
  }, "/admin/settings" + hash, { FormData, ...context });
  await harness.app.startAuthenticated();
  return { ...harness, requests };
}
function activeSettingsPanel(document) {
  return [...document.querySelectorAll('[role="tabpanel"]')].filter(el => !el.hidden).map(el => el.id);
}

test("settings tabs show one section, preserve drafts and save fields across all sections", async () => {
  let saved;
  const { document, window, app } = await settingsHarness({ patch(body) { saved = body; return response({ settings: { ...body, adminPath: "/admin" } }); } });
  assert.equal(document.querySelectorAll('[role="tab"]').length, 7);
  assert.deepEqual(activeSettingsPanel(document), ["siteSettings"]);
  const name = document.querySelector("#siteNameInput");
  name.value = "Draft site";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.click();
    assert.deepEqual(activeSettingsPanel(document), [tab.getAttribute("aria-controls")]);
    assert.equal(tab.getAttribute("aria-selected"), "true");
    assert.equal(document.querySelectorAll('[role="tab"][tabindex="0"]').length, 1);
  }
  document.querySelector("#trackingCodeInput").value = "<script>/* smoke */</script>";
  await app.loadList();
  assert.equal(name.value, "Draft site");
  assert.deepEqual(activeSettingsPanel(document), ["securitySettings"]);
  await app.saveSettings({ preventDefault() {} });
  assert.equal(saved.siteName, "Draft site");
  assert.equal(saved.trackingCode, "<script>/* smoke */</script>");
});

test("settings fragment supports refresh, history and keyboard tab navigation", async () => {
  const { document, window, app, location, navigateHash, requests } = await settingsHarness({ hash: "#trackingSettings" });
  assert.deepEqual(activeSettingsPanel(document), ["trackingSettings"]);
  await app.loadList();
  assert.equal(location.hash, "#trackingSettings");
  const key = (id, value) => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value });
    document.getElementById(id + "Tab").dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  key("trackingSettings", "ArrowRight");
  assert.deepEqual(activeSettingsPanel(document), ["remoteSettings"]);
  key("remoteSettings", "End");
  assert.deepEqual(activeSettingsPanel(document), ["securitySettings"]);
  key("securitySettings", "Home");
  assert.deepEqual(activeSettingsPanel(document), ["siteSettings"]);
  key("siteSettings", "ArrowLeft");
  assert.deepEqual(activeSettingsPanel(document), ["securitySettings"]);
  const count = requests.length;
  await navigateHash("#directorySettings");
  assert.deepEqual(activeSettingsPanel(document), ["directorySettings"]);
  assert.equal(requests.length, count, "switching settings history must not reload or discard form data");
  await navigateHash("#unknown");
  assert.deepEqual(activeSettingsPanel(document), ["siteSettings"]);
});

test("settings save reveals and focuses the first invalid field in a hidden section", async () => {
  const { document, window, app, requests } = await settingsHarness();
  document.querySelector("#remoteSyncEnabledInput").checked = true;
  document.querySelector("#remoteSyncEnabledInput").dispatchEvent(new window.Event("input", { bubbles: true }));
  const field = document.querySelector("#remoteSyncUrlInput");
  Object.defineProperties(field, { willValidate: { value: true }, validity: { value: { valid: false } }, validationMessage: { value: "Please enter a URL" } });
  let focused = false;
  field.focus = () => { focused = true; };
  await app.saveSettings({ preventDefault() {} });
  assert.deepEqual(activeSettingsPanel(document), ["remoteSettings"]);
  assert.equal(focused, true);
  assert.equal(field.getAttribute("aria-invalid"), "true");
  assert.equal(document.querySelector('[data-error-for="remoteSyncUrlInput"]').hidden, false);
  assert.equal(requests.filter(r => r.method === "PATCH").length, 0);
  assert.equal(document.querySelector("#settingsForm").hasAttribute("novalidate"), true, "submit must reach the handler before hidden-field validation");
});

test("server validation opens the affected settings tab without losing other drafts", async () => {
  const { document, window, app } = await settingsHarness({ patch: () => response({ error: "线上接口地址无效" }, 400) });
  document.querySelector("#siteNameInput").value = "Retained draft";
  document.querySelector("#siteNameInput").dispatchEvent(new window.Event("input", { bubbles: true }));
  await app.saveSettings({ preventDefault() {} });
  assert.deepEqual(activeSettingsPanel(document), ["remoteSettings"]);
  assert.equal(document.querySelector("#remoteSyncUrlInput").getAttribute("aria-invalid"), "true");
  assert.equal(document.querySelector("#siteNameInput").value, "Retained draft");
  assert.equal(document.querySelector("#settingsSaveState").textContent, "有未保存修改");
});

test("directory policy shortcut opens the editing settings tab", async () => {
  const { document } = await settingsHarness({ hash: "#directorySettings" });
  document.querySelector("#openSettingsSide").click();
  assert.deepEqual(activeSettingsPanel(document), ["editSettings"]);
});


test("restoring an offscreen settings tab scrolls the tab bar without moving the form", async () => {
  const { document, navigateHash } = await settingsHarness();
  const bar = document.querySelector(".settings-tabs");
  const tab = document.querySelector("#securitySettingsTab");
  bar.scrollLeft = 0;
  bar.getBoundingClientRect = () => ({ left: 100, right: 300 });
  tab.getBoundingClientRect = () => ({ left: 400 - bar.scrollLeft, right: 500 - bar.scrollLeft });
  const main = document.querySelector("#mainContent");
  main.scrollTop = 120;
  await navigateHash("#securitySettings");
  assert.ok(tab.getBoundingClientRect().right <= bar.getBoundingClientRect().right, "the restored selected tab must be visible");
  assert.equal(main.scrollTop, 120);
});


test("turning off remote sync releases URL format validation while retaining its draft", async () => {
  const { document, window, app, requests } = await settingsHarness();
  const enabled = document.querySelector("#remoteSyncEnabledInput");
  const field = document.querySelector("#remoteSyncUrlInput");
  field.value = "unfinished-url";
  Object.defineProperties(field, {
    willValidate: { get: () => !field.disabled },
    validity: { value: { valid: false } },
    validationMessage: { value: "Please enter a URL" },
  });
  enabled.checked = true;
  enabled.dispatchEvent(new window.Event("input", { bubbles: true }));
  await app.saveSettings({ preventDefault() {} });
  assert.equal(requests.filter(r => r.method === "PATCH").length, 0);
  enabled.checked = false;
  enabled.dispatchEvent(new window.Event("input", { bubbles: true }));
  await app.saveSettings({ preventDefault() {} });
  const saves = requests.filter(r => r.method === "PATCH");
  assert.equal(saves.length, 1, "disabled sync must not block saving unrelated settings");
  assert.equal(JSON.parse(saves[0].body).remoteSyncUrl, "unfinished-url");
});

const navigationRows = document => [...document.querySelectorAll("#navigationItems [data-navigation-id]")];
function editNavigation(document, window, row, field, value) {
  const input = row.querySelector(`[data-navigation-field="${field}"]`);
  if (field === "enabled") input.checked = value;
  else input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("navigation editor adds, presets, reorders and saves menus while keeping tab drafts", async () => {
  let saved;
  const { document, window, app } = await settingsHarness({ hash: "#navigationSettings", patch(body) { saved = body; return response({ settings: { ...body, adminPath: "/admin" } }); } });
  assert.deepEqual(activeSettingsPanel(document), ["navigationSettings"]);
  const add = document.querySelector("#addNavigationItem");
  add.click();
  let row = navigationRows(document)[1];
  const preset = row.querySelector("[data-navigation-preset]");
  preset.value = "/type/pdf";
  document.querySelector("#navigationItems").onchange({ target: preset });
  assert.equal(row.querySelector('[data-navigation-field="label"]').value, "PDF文档");
  assert.equal(row.querySelector('[data-navigation-field="url"]').value, "/type/pdf");
  document.querySelector("#navigationItems").onclick({ target: row.querySelector('[data-navigation-action="up"]') });
  add.click();
  row = navigationRows(document)[2];
  editNavigation(document, window, row, "label", " 官网 ");
  editNavigation(document, window, row, "url", " https://example.com ");
  editNavigation(document, window, row, "newTab", "new");
  editNavigation(document, window, row, "enabled", false);
  assert.deepEqual([...document.querySelectorAll("#navigationPreviewLinks span")].map(el => el.textContent), ["PDF文档", "全部文档"]);
  document.querySelector("#siteSettingsTab").click();
  document.querySelector("#navigationSettingsTab").click();
  assert.equal(navigationRows(document)[2].querySelector('[data-navigation-field="label"]').value, " 官网 ");
  await app.saveSettings({ preventDefault() {} });
  assert.deepEqual(saved.publicNavigation.map(item => item.label), ["PDF文档", "全部文档", "官网"]);
  assert.equal(saved.publicNavigation[2].newTab, true);
  assert.equal(saved.publicNavigation[2].enabled, false);
  assert.equal(saved.publicNavigation[2].url, "https://example.com");
  assert.equal(document.querySelector("#settingsSaveState").textContent, "已保存");
  const builtin = navigationRows(document).find(row => row.dataset.navigationId === "all-documents");
  assert.equal(builtin.querySelector('[data-navigation-action="remove"]'), null);
  assert.equal(builtin.querySelector('[data-navigation-field="label"]').disabled, true);
});

test("navigation validation reveals hidden fields and failed save retains menu drafts", async () => {
  const { document, window, app, requests } = await settingsHarness({ patch() { return response({ error: "菜单保存失败", field: "navigationSettings" }, 400); } });
  document.querySelector("#addNavigationItem").click();
  const row = navigationRows(document)[1];
  editNavigation(document, window, row, "label", " ");
  await app.saveSettings({ preventDefault() {} });
  assert.deepEqual(activeSettingsPanel(document), ["navigationSettings"]);
  assert.equal(row.querySelector('[data-navigation-field="label"]').getAttribute("aria-invalid"), "true");
  editNavigation(document, window, row, "label", "指南");
  editNavigation(document, window, row, "url", "javascript:alert(1)");
  await app.saveSettings({ preventDefault() {} });
  assert.equal(row.querySelector('[data-navigation-field="url"]').getAttribute("aria-invalid"), "true");
  assert.equal(requests.filter(request => request.method === "PATCH").length, 0);
  editNavigation(document, window, row, "url", "/type/html");
  document.querySelector("#siteSettingsTab").click();
  await app.saveSettings({ preventDefault() {} });
  assert.deepEqual(activeSettingsPanel(document), ["navigationSettings"]);
  assert.equal(navigationRows(document)[1].querySelector('[data-navigation-field="label"]').value, "指南");
  assert.equal(document.querySelector("#settingsSaveState").textContent, "有未保存修改");
  assert.equal(document.querySelector("#navigationError").hidden, false);
});

test("navigation editor enforces ten items, supports deletion and retains edits made during saving", async () => {
  let finish;
  const { document, window, app } = await settingsHarness({ patch(body) { return new Promise(resolve => { finish = () => resolve(response({ settings: { ...body, adminPath: "/admin" } })); }); } });
  const add = document.querySelector("#addNavigationItem");
  for (let i = 0; i < 9; i++) add.click();
  assert.equal(navigationRows(document).length, 10);
  assert.equal(add.disabled, true);
  for (let i = 9; i > 1; i--) {
    const row = navigationRows(document)[i];
    document.querySelector("#navigationItems").onclick({ target: row.querySelector('[data-navigation-action="remove"]') });
  }
  assert.equal(add.disabled, false);
  let row = navigationRows(document)[1];
  editNavigation(document, window, row, "label", "原菜单");
  editNavigation(document, window, row, "url", "/");
  const saving = app.saveSettings({ preventDefault() {} });
  editNavigation(document, window, row, "label", "保存期间的新修改");
  finish(); await saving;
  row = navigationRows(document)[1];
  assert.equal(row.querySelector('[data-navigation-field="label"]').value, "保存期间的新修改");
  assert.equal(document.querySelector("#settingsSaveState").textContent, "有未保存修改");
});

const analyticsResult = (days = 30, views = 16) => ({
  days, timeZone: "Asia/Shanghai", today: "2026-10-25", generatedAt: "2026-10-25T12:00:00Z", trackingStartedAt: "2026-10-01T00:00:00Z",
  summary: { todayViews: views, totalViews: 12345, yesterdayViews: 8, yesterdayAvailable: true, yesterdayComplete: true, periodViews: views, periodDocuments: 2, dailyAverage: 0.5 },
  documentStats: { all: 3, editable: 3, todayCreated: 1, watchDirs: 1, todayViews: views, totalViews: 12345, byType: { html: 3 } },
  trend: Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 26 - days + i)).toISOString().slice(0, 10), views: i === days - 1 ? views : 0, documents: i === days - 1 ? 2 : 0 })),
  byType: { html: views, pdf: 0, word: 0, other: 0 },
  rankings: Object.fromEntries(["total", "today"].map(mode => [mode, {
    pages: [{ id: "rank-a", title: "文档浏览排行", fileType: "html", url: "/aaaaaa", views: mode === "total" ? 12345 : views, rank: 1, deleted: false }],
    pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1, hasPrev: false, hasNext: false },
  }])),
});

const rankingDetailsResult = (mode = "total", page = 1) => {
  const data = analyticsResult();
  return {
    mode, today: data.today, timeZone: data.timeZone, generatedAt: data.generatedAt,
    views: mode === "total" ? data.summary.totalViews : data.summary.todayViews,
    documentStats: data.documentStats,
    pages: data.rankings[mode].pages,
    pagination: { page, pageSize: 20, total: 21, totalPages: 2, offset: (page - 1) * 20, hasPrev: page > 1, hasNext: page < 2 },
  };
};

test("ranking pagination keeps the new result heading visible after a successful page change", async () => {
  let active, document;
  const h = await appHarness(async url => {
    active = document.body;
    return response(rankingDetailsResult("total", Number(new URL(url, "http://test").searchParams.get("page"))));
  }, "/admin?view=analytics-details&ranking=total");
  document = h.document;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  const proto = h.window.HTMLElement.prototype, previousFocus = proto.focus;
  const main = document.querySelector("#mainContent");
  proto.focus = function (options = {}) {
    active = this;
    if (this.closest("#rankingDetailsPager") && !options.preventScroll) main.scrollTop = 900;
  };
  try {
    h.app.setSession(true);
    await h.app.loadList();
    const next = document.querySelector('#rankingDetailsPager [aria-label="下一页"]');
    next.focus();
    await h.clickRanking(next);
    assert.equal(main.scrollTop, 0, "footer focus must not undo the scroll to the new page's first rows");
    assert.equal(active.id, "rankingDetailsTitle");
  } finally { proto.focus = previousFocus; }
});

test("clicking the current ranking page does not repeat a request or push duplicate history", async () => {
  let requests = 0, pushes = 0;
  const h = await appHarness(async url => {
    requests++;
    return response(rankingDetailsResult("total", Number(new URL(url, "http://test").searchParams.get("page"))));
  }, "/admin?view=analytics-details&ranking=total", {
    history: { state: null, replaceState() {}, pushState() { pushes++; }, back() {} },
  });
  h.app.setSession(true);
  await h.app.loadList();
  await h.clickRanking(h.document.querySelector('#rankingDetailsPager [aria-current="page"]'));
  assert.equal(pushes, 0);
  assert.equal(requests, 1);
  await h.clickRanking(h.document.querySelector('#rankingDetailsPager [aria-label="下一页"]'));
  assert.equal(pushes, 1, "a real page change still creates a navigable history entry");
  assert.equal(requests, 2);
});

test("analytics overview shows only Top 10 and always exposes both independent detail links", async () => {
  const data = analyticsResult(7);
  for (const mode of ["total", "today"]) {
    data.rankings[mode].pages = Array.from({ length: 23 }, (_, i) => ({ id: String(i), title: `文档 ${i + 1}`, fileType: "html", url: "/aaaaaa", views: 23 - i, rank: i + 1 }));
  }
  const requests = [];
  const { app, document, location } = await appHarness(async url => { requests.push(url); return response(data); }, "/ops?view=analytics&days=7&totalPage=2&todayPage=3");
  app.setSession(true);
  await app.loadList();
  assert.equal(document.querySelectorAll("#totalRanking tbody tr").length, 10);
  assert.equal(document.querySelectorAll("#todayRanking tbody tr").length, 10);
  assert.equal(document.querySelector("#totalRankingPager, #todayRankingPager"), null);
  assert.doesNotMatch(requests[0], /totalPage|todayPage/);
  assert.doesNotMatch(location.search, /totalPage|todayPage/);
  for (const mode of ["total", "today"]) {
    const link = document.querySelector("#" + mode + "RankingDetailsLink");
    const url = new URL(link.getAttribute("href"), "http://test");
    assert.equal(url.pathname, "/ops");
    assert.equal(url.searchParams.get("view"), "analytics-details");
    assert.equal(url.searchParams.get("ranking"), mode);
    assert.equal(url.searchParams.get("days"), "7");
    data.rankings[mode].pages = [];
  }
  await app.loadList();
  assert.match(document.querySelector("#todayRanking").textContent, /暂无/);
  assert.ok(document.querySelector("#todayRankingDetailsLink").getAttribute("href"));
});

test("ranking detail deep links show the correct mode, full counts and a range-preserving return link", async () => {
  const data = rankingDetailsResult("today", 2);
  data.pages[0].views = 123456789;
  data.views = 123456789;
  const requests = [];
  const { app, document, location } = await appHarness(async url => { requests.push(url); return response(data); }, "/ops?view=analytics-details&ranking=today&page=2&days=7");
  app.setSession(true);
  await app.loadList();
  const request = new URL(requests[0], "http://test");
  assert.equal(request.pathname, "/ops/api/analytics/rankings");
  assert.equal(request.searchParams.get("mode"), "today");
  assert.equal(request.searchParams.get("page"), "2");
  assert.equal(document.querySelector("#analyticsDetailsView").hidden, false);
  for (const id of ["analyticsView", "workspaceStats", "uploadView", "managerView", "managerActions"]) assert.equal(document.querySelector("#" + id).hidden, true);
  assert.equal(document.querySelector("#workspaceTitle").textContent, "今日浏览明细");
  assert.equal(document.querySelector('[data-nav-type="analytics"]').getAttribute("aria-current"), "page");
  assert.equal(document.querySelector("#rankingDetailsBack").getAttribute("href"), "/ops?view=analytics&days=7");
  assert.match(document.querySelector("#rankingDetailsDescription").textContent, /2026-10-25/);
  assert.equal(document.querySelector("#rankingDetailsTable td.number").textContent, "123,456,789");
  assert.equal(document.querySelector('#rankingDetailsPager [aria-current="page"]').dataset.page, "2");
  assert.equal(new URLSearchParams(location.search).get("ranking"), "today");
});

test("ranking details restore mode and page through browser history", async () => {
  const { app, document, navigate } = await appHarness(async url => {
    const p = new URL(url, "http://test").searchParams;
    return response(url.includes("/analytics/rankings") ? rankingDetailsResult(p.get("mode"), Number(p.get("page"))) : analyticsResult(90));
  });
  app.setSession(true);
  await navigate("?view=analytics-details&ranking=total&page=2&days=90");
  assert.equal(document.querySelector("#workspaceTitle").textContent, "累计浏览明细");
  assert.equal(document.querySelector('#rankingDetailsPager [aria-current="page"]').dataset.page, "2");
  await navigate("?view=analytics&days=90");
  assert.equal(document.querySelector("#analyticsDetailsView").hidden, true);
  assert.equal(document.querySelector("#analyticsView").hidden, false);
  await navigate("?view=analytics-details&ranking=today&days=90");
  assert.equal(document.querySelector("#workspaceTitle").textContent, "今日浏览明细");
});

test("ranking details ignore superseded results and hide data when a session expires", async () => {
  const pending = [];
  const { app, document } = await appHarness(() => new Promise(resolve => pending.push(resolve)), "/admin?view=analytics-details&ranking=total");
  app.setSession(true);
  const first = app.loadList();
  app.setFilters({ ranking: "today" });
  const second = app.loadList();
  pending[1](response(rankingDetailsResult("today")));
  await second;
  pending[0](response(rankingDetailsResult("total")));
  await first;
  assert.equal(document.querySelector("#workspaceTitle").textContent, "今日浏览明细");
  assert.equal(document.querySelector("#rankingDetailsTable td.number").textContent, "16");
  const third = app.loadList();
  app.showLogin();
  pending[2](response(rankingDetailsResult("today")));
  await third;
  assert.equal(document.querySelector("#rankingDetailsContent").hidden, true);
});

test("ranking details recover from network errors into an accurate empty state", async () => {
  let failing = true;
  const data = rankingDetailsResult("today");
  data.pages = [];
  data.views = data.pagination.total = 0;
  data.pagination.totalPages = 1;
  const { app, document } = await appHarness(async () => {
    if (failing) throw new Error("网络中断");
    return response(data);
  }, "/admin?view=analytics-details&ranking=today");
  app.setSession(true);
  await app.loadList();
  assert.equal(document.querySelector("#rankingDetailsError").hidden, false);
  assert.equal(document.querySelector("#rankingDetailsContent").hidden, true);
  assert.ok(document.querySelector("#rankingDetailsBack").getAttribute("href"));
  failing = false;
  await document.querySelector("#refreshRankingDetails").onclick();
  assert.equal(document.querySelector("#rankingDetailsError").hidden, true);
  assert.match(document.querySelector("#rankingDetailsTable").textContent, /今日暂无文档浏览记录/);
  assert.equal(document.querySelector("#rankingDetailsCount").textContent, "共 0 份文档 · 0 次浏览");
  assert.equal(document.querySelector("#rankingDetailsPager").hidden, true);
});

test("analytics deep links use the existing shell and display live metrics, trends and rankings", async () => {
  const requests = [];
  const { app, document, location } = await appHarness(async url => { requests.push(url); return response(analyticsResult(7)); }, "/ops?view=analytics&days=7");
  app.setSession(true);
  await app.loadList();
  assert.match(requests[0], /^\/ops\/api\/analytics\?days=7/);
  assert.equal(document.querySelector("#analyticsView").hidden, false);
  for (const id of ["workspaceStats", "uploadView", "managerView", "managerActions"]) assert.equal(document.querySelector("#" + id).hidden, true);
  assert.equal(document.querySelector("#workspaceTitle").textContent, "数据分析");
  assert.equal(document.querySelector('[data-nav-type="analytics"]').getAttribute("aria-current"), "page");
  assert.equal(document.querySelector('[data-nav-type="analytics"]').getAttribute("href"), "/ops?view=analytics");
  assert.equal(document.querySelector("#analyticsToday").textContent, "16");
  assert.equal(document.querySelector("#analyticsTotal").textContent, "1.2万");
  assert.match(document.querySelector("#analyticsComparison").textContent, /增加 100%/);
  assert.equal(document.querySelectorAll("#analyticsDailyRows tr").length, 7);
  assert.equal(document.querySelector("#totalRanking a").getAttribute("href"), "/aaaaaa");
  assert.equal(document.querySelectorAll("#analyticsChart svg").length, 1);
  assert.equal(document.querySelector("#analyticsContent").getAttribute("aria-busy"), "false");
  assert.equal(new URLSearchParams(location.search).get("view"), "analytics");
});

test("analytics browser history restores range and returns to the document workspace", async () => {
  const { app, document, navigate } = await appHarness(async url => url.includes("/api/analytics") ? response(analyticsResult(Number(new URL(url, "http://test").searchParams.get("days")))) : response(listResult));
  app.setSession(true);
  await navigate("?view=analytics&days=90");
  assert.equal(document.querySelector("#analyticsRange").value, "90");
  assert.match(document.querySelector("#analyticsPeriodLabel").textContent, /90/);
  await navigate("?view=documents");
  assert.equal(document.querySelector("#analyticsView").hidden, true);
  assert.equal(document.querySelector("#managerView").hidden, false);
  assert.equal(document.querySelector("#workspaceStats").hidden, false);
});

test("analytics ignores superseded responses and session invalidation", async () => {
  const pending = [];
  const { app, document } = await appHarness(() => new Promise(resolve => pending.push(resolve)), "/admin?view=analytics");
  app.setSession(true);
  const first = app.loadList();
  app.setFilters({ analyticsDays: 7 });
  const second = app.loadList();
  pending[1](response(analyticsResult(7, 24)));
  await second;
  pending[0](response(analyticsResult(30, 16)));
  await first;
  assert.equal(document.querySelector("#analyticsToday").textContent, "24");
  assert.match(document.querySelector("#analyticsPeriodLabel").textContent, /7/);
  const third = app.loadList();
  app.showLogin();
  pending[2](response(analyticsResult(7, 99)));
  await third;
  assert.equal(document.querySelector("#analyticsContent").hidden, true);
  assert.equal(document.body.dataset.auth, "guest");
});

test("analytics handles network failure and real empty data without fabricated counts", async () => {
  let failing = true;
  const empty = analyticsResult(30, 0);
  empty.rankings.today.pages = [];
  empty.trend[0] = { ...empty.trend[0], views: null, documents: null };
  const { app, document } = await appHarness(async () => {
    if (failing) throw new Error("网络中断");
    return response(empty);
  }, "/admin?view=analytics");
  app.setSession(true);
  await app.loadList();
  assert.equal(document.querySelector("#analyticsError").hidden, false);
  assert.match(document.querySelector("#analyticsError").textContent, /网络中断/);
  assert.equal(document.querySelector("#analyticsContent").hidden, true);
  failing = false;
  await document.querySelector("#refreshAnalytics").onclick();
  assert.equal(document.querySelector("#analyticsError").hidden, true);
  assert.equal(document.querySelector("#analyticsToday").textContent, "0");
  assert.match(document.querySelector("#todayRanking").textContent, /暂无/);
  assert.match(document.querySelector("#analyticsDailyRows").textContent, /未记录/);
  assert.doesNotMatch(document.querySelector("#analyticsChart").innerHTML, /NaN|Infinity/);
});

test("analytics compact large ranking and type counts while retaining full values", async () => {
  const data = analyticsResult();
  data.rankings.total.pages[0].views = 123456789;
  data.byType.html = data.summary.periodViews = 123456789;
  const { app, document } = await appHarness(async () => response(data), "/admin?view=analytics");
  app.setSession(true);
  await app.loadList();
  const cell = document.querySelector("#totalRanking .number[title]");
  assert.equal(cell.textContent, "1.2亿");
  assert.equal(cell.title, "123,456,789");
  assert.equal(document.querySelector("#analyticsTypes strong").textContent, "1.2亿");
  assert.equal(document.querySelector("#analyticsTypes strong").title, "123,456,789");
});

test("analytics labels partial yesterday data and compares only complete days", async () => {
  const data = analyticsResult(7, 10);
  data.summary.yesterdayViews = 1;
  data.summary.yesterdayComplete = false;
  const { app, document } = await appHarness(async () => response(data), "/admin?view=analytics");
  app.setSession(true);
  await app.loadList();
  assert.equal(document.querySelector("#analyticsYesterday").textContent, "1");
  assert.match(document.querySelector("#analyticsComparison").textContent, /暂不比较/);
  assert.match(document.querySelector("#analyticsYesterdayNote").textContent, /部分时段/);
  data.summary.yesterdayComplete = true;
  await app.loadList();
  assert.match(document.querySelector("#analyticsComparison").textContent, /增加 900%/);
  data.summary.yesterdayAvailable = false;
  data.summary.yesterdayComplete = false;
  await app.loadList();
  assert.equal(document.querySelector("#analyticsYesterday").textContent, "-");
  assert.match(document.querySelector("#analyticsYesterdayNote").textContent, /尚未开始记录/);
});

test("analytics chart observes container changes without requiring window resize", async () => {
  let resize, observed;
  const { app, document } = await appHarness(async () => response(analyticsResult()), "/admin?view=analytics", {
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe(target) { observed = target; }
    },
  });
  const chart = document.querySelector("#analyticsChart");
  let width = 730;
  Object.defineProperty(chart, "clientWidth", { get: () => width });
  app.setSession(true);
  await app.loadList();
  assert.equal(chart.querySelector("svg").getAttribute("viewBox"), "0 0 698 240");
  assert.ok(observed === chart, "the chart container must be observed for sidebar layout changes");
  width = 958;
  resize();
  assert.equal(chart.querySelector("svg").getAttribute("viewBox"), "0 0 926 240");
  const stableSvg = chart.querySelector("svg");
  resize();
  assert.equal(chart.querySelector("svg"), stableSvg, "height notifications must not cause a repaint loop");
  width = 638;
  resize();
  assert.equal(chart.querySelector("svg").getAttribute("viewBox"), "0 0 606 240");
});

test("analytics keyboard pagination focuses retry after failure and the new results after success", async () => {
  let failing = false, active, document;
  const h = await appHarness(async url => {
    active = document.body;
    if (failing) throw new Error("网络中断");
    const page = Number(new URL(url, "http://test").searchParams.get("page"));
    return response(rankingDetailsResult("total", page));
  }, "/admin?view=analytics-details&ranking=total", {
    notice(el, message) {
      el.hidden = false;
      el.textContent = message;
      const retry = el.ownerDocument.createElement("button");
      retry.dataset.retry = "";
      retry.textContent = "重试";
      el.append(retry);
    },
  });
  document = h.document;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  const proto = h.window.HTMLElement.prototype;
  const previousFocus = proto.focus;
  proto.focus = function () { active = this; };
  try {
    h.app.setSession(true);
    await h.app.loadList();
    const next = document.querySelector('#rankingDetailsPager [aria-label="下一页"]');
    next.focus();
    failing = true;
    await h.clickRanking(next);
    assert.equal(document.querySelector("#rankingDetailsContent").hidden, true);
    assert.ok(active === document.querySelector("#rankingDetailsError [data-retry]"), "failed keyboard paging must retain a visible continuation");
    failing = false;
    await h.app.loadList();
    assert.equal(active.id, "refreshRankingDetails", "successful retry must keep focus on a visible control");
    const previous = document.querySelector('#rankingDetailsPager [aria-label="上一页"]');
    previous.focus();
    await h.clickRanking(previous);
    assert.equal(document.querySelector("#rankingDetailsContent").hidden, false);
    assert.equal(active.id, "rankingDetailsTitle");
  } finally { proto.focus = previousFocus; }
});

test("analytics paging preserves newer user focus while an older page request completes", async () => {
  let deferred = false, resolvePage, active, document;
  const h = await appHarness(async () => {
    if (deferred) {
      active = document.body;
      return new Promise(resolve => { resolvePage = resolve; });
    }
    return response(rankingDetailsResult());
  }, "/admin?view=analytics-details&ranking=total");
  document = h.document;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  const proto = h.window.HTMLElement.prototype, previousFocus = proto.focus;
  proto.focus = function () { active = this; };
  try {
    h.app.setSession(true);
    await h.app.loadList();
    const next = document.querySelector('#rankingDetailsPager [aria-label="下一页"]');
    next.focus();
    deferred = true;
    const paging = h.clickRanking(next);
    const range = document.querySelector("#rankingDetailsBack");
    range.focus();
    resolvePage(response(rankingDetailsResult("total", 2)));
    await paging;
    assert.ok(active === range, "a completed page request must preserve a newer focus choice");
  } finally { proto.focus = previousFocus; }
});
test("brand settings preview editable text and image, validate URLs and restore the default icon", async () => {
  let saved;
  const { document, window, app, requests } = await settingsHarness({ patch(body) { saved = body; return response({ settings: { ...body, adminPath: "/admin" } }); } });
  const input = (id, value) => {
    document.getElementById(id).value = value;
    document.getElementById(id).dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  input("siteNameInput", "团队资料库");
  input("publicBrandCaptionInput", "资料与知识");
  input("publicLogoUrlInput", "https://example.com/logo.png");
  assert.equal(document.querySelector("#brandPreviewTitle").textContent, "团队资料库");
  assert.equal(document.querySelector("#brandPreviewCaption").textContent, "资料与知识");
  assert.equal(document.querySelector("#brandPreviewImage").getAttribute("src"), "https://example.com/logo.png");
  await app.saveSettings({ preventDefault() {} });
  assert.equal(saved.publicLogoUrl, "https://example.com/logo.png");
  assert.equal(saved.publicBrandCaption, "资料与知识");
  input("publicLogoUrlInput", "javascript:alert(1)");
  document.querySelector("#navigationSettingsTab").click();
  await app.saveSettings({ preventDefault() {} });
  assert.deepEqual(activeSettingsPanel(document), ["siteSettings"]);
  assert.equal(document.querySelector("#publicLogoUrlInput").getAttribute("aria-invalid"), "true");
  assert.equal(requests.filter(request => request.method === "PATCH").length, 1);
  document.querySelector("#resetBrandLogo").click();
  input("publicBrandCaptionInput", "");
  assert.equal(document.querySelector("#brandPreviewImage").hidden, true);
  assert.equal(document.querySelector("#brandPreviewCaption").hidden, true);
  await app.saveSettings({ preventDefault() {} });
  assert.equal(saved.publicLogoUrl, "");
  assert.equal(saved.publicBrandCaption, "");
});

test("pending logo upload blocks saving and preserves other edits until the image is staged", async () => {
  let finish;
  const { document, window, app, requests } = await settingsHarness({ upload() { return new Promise(resolve => { finish = resolve; }); } });
  const pending = document.querySelector("#brandLogoFile").onchange({ target: { files: [new File(["logo"], "logo.png", { type: "image/png" })] } });
  assert.equal(document.querySelector("#saveSettingsTop").disabled, true);
  assert.equal(document.querySelector("#publicLogoUrlInput").disabled, true);
  await app.saveSettings({ preventDefault() {} });
  assert.equal(requests.filter(request => request.method === "PATCH").length, 0);
  document.querySelector("#publicBrandCaptionInput").value = "上传期间的新副标题";
  document.querySelector("#publicBrandCaptionInput").dispatchEvent(new window.Event("input", { bubbles: true }));
  finish(response({ url: "/public/brand/logo-test.png" }));
  await pending;
  assert.equal(document.querySelector("#publicLogoUrlInput").value, "/public/brand/logo-test.png");
  assert.equal(document.querySelector("#publicBrandCaptionInput").value, "上传期间的新副标题");
  assert.equal(document.querySelector("#saveSettingsTop").disabled, false);
  assert.equal(document.querySelector("#settingsSaveState").textContent, "有未保存修改");
});

test("logo upload responses from an expired session cannot replace a recovered session draft", async () => {
  let finish;
  const { document, window, app } = await settingsHarness({ upload() { return new Promise(resolve => { finish = resolve; }); } });
  const pending = document.querySelector("#brandLogoFile").onchange({ target: { files: [new File(["logo"], "logo.png", { type: "image/png" })] } });
  app.showLogin();
  await app.startAuthenticated();
  const field = document.querySelector("#publicLogoUrlInput");
  field.value = "/new-session.png";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  finish(response({ url: "/old-session.png" }));
  await pending;
  assert.equal(field.value, "/new-session.png");
  assert.equal(document.querySelector("#saveSettingsTop").disabled, false);
});

test("failed brand preview keeps the default icon when other brand fields change", async () => {
  const { document, window } = await settingsHarness();
  const url = document.querySelector("#publicLogoUrlInput");
  url.value = "/missing-logo.png";
  url.dispatchEvent(new window.Event("input", { bubbles: true }));
  const image = document.querySelector("#brandPreviewImage");
  Object.defineProperty(image, "complete", { configurable: true, value: true });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 0 });
  image.onerror();
  const caption = document.querySelector("#publicBrandCaptionInput");
  caption.value = "修改副标题";
  caption.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(image.hidden, true);
  assert.equal(document.querySelector("#brandPreviewSymbol").hidden, false);
  url.value = "/replacement.png";
  url.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(image.getAttribute("src"), "/replacement.png");
  assert.equal(image.hidden, false);
});

test("logo chooser resets before upload so the same file remains retryable after session expiry", async () => {
  const { document, app } = await settingsHarness({ upload: () => response({ error: "Unauthorized" }, 401) });
  const chooser = document.querySelector("#brandLogoFile");
  Object.defineProperty(chooser, "files", { value: [new File(["logo"], "logo.png", { type: "image/png" })] });
  chooser.value = "C:\\fakepath\\logo.png";
  await chooser.onchange({ target: chooser });
  assert.equal(chooser.value, "");
  await app.startAuthenticated();
  assert.equal(chooser.value, "");
});
