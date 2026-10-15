import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";

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
    paginationHtml: () => "",
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

test("public portal exposes only reading controls and supports shared navigation", async () => {
  const doc = await documentAt("public/index-public.html");
  for (const type of ["all", "html", "pdf", "word"])
    assert.ok(doc.querySelector(`[data-type="${type}"]`));
  for (const id of [
    "searchInput",
    "sortSelect",
    "docRows",
    "pagination",
    "clearFilters",
    "sidebarToggle",
    "sidebarResizer",
  ])
    assert.ok(doc.getElementById(id), id);
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


async function settingsHarness({ hash = "", patch } = {}) {
  const requests = [];
  const initial = { adminPath: "/admin", siteName: "Test", adminName: "Test", authUsername: "admin" };
  const harness = await appHarness(async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === "PATCH") return patch ? patch(JSON.parse(options.body)) : response({ settings: { ...initial, ...JSON.parse(options.body) } });
    if (url.endsWith("/api/settings")) return response({ settings: initial, runtime: {} });
    if (url.endsWith("/api/watch-dirs")) return response({ watchDirs: [] });
    return response(listResult);
  }, "/admin/settings" + hash);
  await harness.app.startAuthenticated();
  return { ...harness, requests };
}
function activeSettingsPanel(document) {
  return [...document.querySelectorAll('[role="tabpanel"]')].filter(el => !el.hidden).map(el => el.id);
}

test("settings tabs show one section, preserve drafts and save fields across all sections", async () => {
  let saved;
  const { document, window, app } = await settingsHarness({ patch(body) { saved = body; return response({ settings: { ...body, adminPath: "/admin" } }); } });
  assert.equal(document.querySelectorAll('[role="tab"]').length, 6);
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
