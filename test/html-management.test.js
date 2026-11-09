import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/server.js";

const original = '<!doctype html><html><head><title>原报告</title></head><body><h1>原内容</h1></body></html>';
const replacement = '<!doctype html><html><head><title>更新报告</title><style>h1{color:blue}</style></head><body><h1>替换后的内容</h1></body></html>';

async function fixture(t, overrides = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "liekan-html-")));
  const app = await buildApp({ rootDir: dataDir, dataDir, uploadsDir: path.join(dataDir, "uploads"), generatedDir: path.join(dataDir, "pages"), versionsDir: path.join(dataDir, "versions"), publicDir: path.resolve("public"), watchDirs: [], allowSourceWrite: false, ...overrides });
  await app.ready();
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const cookie = `tokdoc_session=${app.store.createSessionToken("admin")}`;
  const page = await app.store.importBuffer({ fileName: "report.html", buffer: Buffer.from(original) });
  return { app, page, cookie, dataDir };
}

function multipart(html, revision = 1, fileName = "updated.html", extraFile = false) {
  const boundary = "liekan-html-boundary";
  const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="revision"\r\n\r\n${revision}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/html\r\n\r\n`), Buffer.isBuffer(html) ? html : Buffer.from(html)];
  if (extraFile) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="other.html"\r\nContent-Type: text/html\r\n\r\n${replacement}`));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

test("document uploads accept exactly 50 MiB and reject one extra byte through both upload endpoints", async t => {
  const { app, cookie } = await fixture(t);
  const limit = 50 * 1024 * 1024;
  for (const endpoint of ["/admin/api/pages/upload", "/admin/api/pages/upload/prepare"]) {
    for (const size of [limit, limit + 1]) {
      const file = Buffer.alloc(size, 32);
      file.write("%PDF-1.4\n");
      const request = multipart(file, 1, "limit.pdf");
      const response = await app.inject({ method: "POST", url: endpoint, ...request, headers: { ...request.headers, cookie } });
      assert.equal(response.statusCode, size === limit ? 201 : 413, `${endpoint}: ${response.body}`);
      if (response.statusCode === 201 && endpoint.endsWith("/prepare")) {
        const staged = response.json();
        const manifest = await app.store.readStagedUploadManifest(staged.uploadId);
        assert.equal(manifest.files[0].size, limit);
        await app.store.cancelStagedUpload(staged.uploadId);
      } else if (response.statusCode === 201) {
        assert.equal((await fs.stat(response.json().pages[0].sourcePath)).size, limit);
      }
    }
  }
});

test("HTML replacement accepts a file at the 50 MiB boundary", async t => {
  const { app, page, cookie } = await fixture(t);
  const limit = 50 * 1024 * 1024;
  const html = replacement.replace("</body>", `<!--${"a".repeat(limit - Buffer.byteLength(replacement) - 7)}--></body>`);
  assert.equal(Buffer.byteLength(html), limit);
  const response = await replace(app, page, cookie, html);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok((await fs.stat(page.sourcePath)).size >= limit);
  assert.equal(response.json().page.revision, 2);
});

async function replace(app, page, cookie, html = replacement, revision = page.revision, fileName, extraFile) {
  const request = multipart(html, revision, fileName, extraFile);
  return app.inject({ method: "POST", url: `${app.store.getAdminPath()}/api/pages/${page.id}/replace`, ...request, headers: { ...request.headers, ...(cookie ? { cookie } : {}) } });
}

test("replacement metadata returns the latest revision without reading or transferring the HTML body", async t => {
  const { app, page, cookie } = await fixture(t);
  await app.store.savePageContent(page.id, { html: "<h1>最新内容</h1>", revision: page.revision });
  let reads = 0;
  const readHtml = app.store.readPageHtml.bind(app.store);
  app.store.readPageHtml = async (...args) => { reads++; return readHtml(...args); };
  const response = await app.inject({ url: "/admin/api/pages/" + page.id + "/metadata", headers: { cookie } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().page.revision, 2);
  assert.equal(response.json().page.url, page.url);
  assert.equal(response.json().page.canEdit, true);
  assert.equal(Object.hasOwn(response.json(), "html"), false);
  assert.equal(reads, 0);
  assert.ok(Buffer.byteLength(response.body) < 5000);
  assert.equal(response.headers["cache-control"], "no-store");
  const source = await app.inject({ url: "/admin/api/pages/" + page.id, headers: { cookie } });
  assert.equal(source.statusCode, 200);
  assert.match(source.json().html, /最新内容/);
  assert.equal(reads, 1, "the source editor must still read the actual HTML");
});

test("replacement metadata requires login and excludes missing or trashed documents", async t => {
  const { app, page, cookie } = await fixture(t);
  const url = "/admin/api/pages/" + page.id + "/metadata";
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url: "/admin/api/pages/missing/metadata", headers: { cookie } })).statusCode, 404);
  await app.store.deletePage(page.id);
  assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 404);
});

test("HTML replacement updates the same link and uploaded file while preserving identity, access and a restorable snapshot", async t => {
  const { app, page, cookie } = await fixture(t);
  await app.store.access.update(page.id, { homepageListed: false, passwordAction: "set", password: "reader-secret" });
  app.store.incrementAccessCount(page.id);
  const before = app.store.getPage(page.id);
  const response = await replace(app, before, cookie);
  assert.equal(response.statusCode, 200, response.body);
  const after = response.json().page;
  for (const key of ["id", "slug", "url", "fileName", "createdAt", "directoryName", "visibility", "homepageListed", "hasAccessPassword", "accessCount"]) assert.equal(after[key], before[key], key);
  assert.equal(after.revision, 2);
  assert.equal(after.title, "更新报告");
  assert.match(await fs.readFile(page.sourcePath, "utf8"), /替换后的内容/);
  const read = await app.inject({ url: page.url, headers: { cookie } });
  assert.match(read.body, /替换后的内容/);
  assert.equal(read.headers["cache-control"], "no-store");
  const guest = await app.inject({ url: page.url });
  assert.doesNotMatch(guest.body, /替换后的内容/);
  const versions = app.store.listVersions(page.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].reason, "replace-file");
  const restored = await app.store.restoreVersion(page.id, versions[0].id);
  assert.match(await app.store.readPageHtml(restored), /原内容/);
  assert.match(await fs.readFile(page.sourcePath, "utf8"), /替换后的内容/);
  assert.equal(restored.url, page.url);
});

test("HTML replacement and source saves reject stale revisions without changing the current document", async t => {
  const { app, page, cookie } = await fixture(t);
  const saved = await app.inject({ method: "PATCH", url: `/admin/api/pages/${page.id}/content`, headers: { cookie }, payload: { html: replacement, revision: 1, reason: "source-edit" } });
  assert.equal(saved.statusCode, 200);
  assert.equal((await replace(app, page, cookie)).statusCode, 409);
  const stale = await app.inject({ method: "PATCH", url: `/admin/api/pages/${page.id}/content`, headers: { cookie }, payload: { html: original, revision: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.match(await app.store.readPageHtml(page), /替换后的内容/);
  assert.equal(app.store.listVersions(page.id).length, 1);
});

test("replacement validates authentication, revision, file count, type, encoding, empty content and size before changing files", async t => {
  const { app, page, cookie } = await fixture(t);
  const cases = [
    [replacement, 1, "updated.html", false, 401, ""],
    [replacement, "", "updated.html", false, 400, cookie],
    [replacement, 1, "updated.pdf", false, 400, cookie],
    ["", 1, "updated.html", false, 400, cookie],
    ["plain text", 1, "updated.html", false, 400, cookie],
    [Buffer.from([0xff, 0xfe, 0x00]), 1, "updated.html", false, 400, cookie],
    [replacement, 1, "updated.html", true, 400, cookie],
    [Buffer.alloc(50 * 1024 * 1024 + 1, 65), 1, "updated.html", false, 413, cookie],
  ];
  for (const [html, revision, fileName, extra, expected, auth] of cases) {
    const response = await replace(app, page, auth, html, revision, fileName, extra);
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(app.store.getPage(page.id).revision, 1);
    assert.equal(await fs.readFile(page.sourcePath, "utf8"), original);
    assert.equal(app.store.listVersions(page.id).length, 0);
  }
});

test("source editor accepts HTML larger than Fastify's default JSON limit and rejects empty or oversized content", async t => {
  const { app, page, cookie } = await fixture(t);
  const html = replacement.replace("</body>", `<p>${"a".repeat(21 * 1024 * 1024)}</p></body>`);
  const response = await app.inject({ method: "PATCH", url: `/admin/api/pages/${page.id}/content`, headers: { cookie }, payload: { html, revision: 1 } });
  assert.equal(response.statusCode, 200, response.body);
  for (const [invalid, code] of [["", 400], [23, 400], ["<p>\0</p>", 400], ["<p>" + "a".repeat(50 * 1024 * 1024) + "</p>", 413]]) {
    const result = await app.inject({ method: "PATCH", url: `/admin/api/pages/${page.id}/content`, headers: { cookie }, payload: { html: invalid, revision: 2 } });
    assert.equal(result.statusCode, code, result.body);
  }
  assert.equal(app.store.getPage(page.id).revision, 2);
});

test("replacing a directory HTML keeps its asset base and permissions on the original attachments", async t => {
  const { app, cookie } = await fixture(t);
  const [page] = await app.store.importUploadFiles([
    { fileName: "index.html", relativePath: "campaign/index.html", buffer: Buffer.from(original.replace("</body>", '<img src="logo.png"></body>')) },
    { fileName: "logo.png", relativePath: "campaign/logo.png", buffer: Buffer.from("image") },
  ]);
  const before = await app.store.readPageHtml(page);
  const base = before.match(/<base[^>]*href="([^"]+)"/)[1];
  const response = await replace(app, page, cookie, replacement.replace("</body>", '<img src="logo.png"></body>'));
  assert.equal(response.statusCode, 200, response.body);
  assert.ok((await app.store.readPageHtml(page)).includes(base));
  const asset = await app.inject({ url: base + "logo.png" });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.body, "image");
});

test("PDF and trashed documents cannot be replaced and custom admin paths enforce the same authentication", async t => {
  const { app, page, cookie } = await fixture(t, { adminPathOverride: "/control" });
  const pdf = await app.store.importBuffer({ fileName: "report.pdf", buffer: Buffer.from("%PDF-1.4") });
  assert.equal((await replace(app, pdf, cookie)).statusCode, 400);
  assert.equal((await replace(app, page, "")).statusCode, 401);
  assert.equal((await replace(app, page, cookie)).statusCode, 200);
  await app.store.deletePage(page.id);
  assert.equal((await replace(app, app.store.getPage(page.id), cookie)).statusCode, 404);
  const hidden = await app.inject({ method: "POST", url: `/admin/api/pages/${page.id}/replace`, headers: { cookie }, payload: {} });
  assert.equal(hidden.statusCode, 404);
});

test("watched HTML replacements respect writeback and survive rescanning without a duplicate revision", async t => {
  const { app, cookie, dataDir } = await fixture(t);
  for (const allowWrite of [false, true]) {
    const directory = path.join(dataDir, allowWrite ? "writable" : "readonly");
    const watch = await app.store.addWatchDir({ path: directory, allowWrite });
    const source = path.join(directory, "watched.html");
    await fs.writeFile(source, original);
    const page = await app.store.upsertWatchedFile(source);
    const response = await replace(app, page, cookie);
    assert.equal(response.statusCode, 200, response.body);
    assert.match(await app.store.readPageHtml(page), /替换后的内容/);
    assert.match(await fs.readFile(source, "utf8"), allowWrite ? /替换后的内容/ : /原内容/);
    await app.store.rescanWatchDir(watch.id);
    assert.equal(app.store.getPage(page.id).revision, 2);
    assert.equal(app.store.listVersions(page.id).length, 1);
  }
});

test("replacement preserves HTML fragments, configured tracking and source file permissions", async t => {
  const { app, page, cookie } = await fixture(t);
  await app.store.saveSettings({ trackingCode: '<script data-test-tracking>window.tracking=true;</script>' });
  await fs.chmod(page.sourcePath, 0o600);
  const response = await replace(app, page, cookie, '<title>新标题</title><h1>首段</h1><p>后续正文必须保留</p>');
  assert.equal(response.statusCode, 200, response.body);
  const html = await app.store.readPageHtml(page);
  assert.match(html, /后续正文必须保留/);
  assert.match(html, /data-test-tracking/);
  assert.equal((await fs.stat(page.sourcePath)).mode & 0o777, 0o600);
});

test("large source editing requests authenticate before JSON parsing and hidden admin paths stay hidden", async t => {
  const { app, page } = await fixture(t, { adminPathOverride: "/control" });
  const payload = '{"html":"' + "a".repeat(2 * 1024 * 1024);
  for (const [prefix, expected] of [["/control", 401], ["/admin", 404]]) {
    const response = await app.inject({ method: "PATCH", url: `${prefix}/api/pages/${page.id}/content`, headers: { "content-type": "application/json" }, payload });
    assert.equal(response.statusCode, expected, response.body);
  }
});

test("a failed generated file replacement restores the uploaded source and leaves the readable document intact", async t => {
  const { app, page, cookie } = await fixture(t);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === page.generatedPath) throw Object.assign(new Error("Simulated write failure"), { code: "EIO" });
    return rename(from, to);
  });
  const response = await replace(app, page, cookie);
  assert.equal(response.statusCode, 500);
  assert.equal(await fs.readFile(page.sourcePath, "utf8"), original);
  assert.match(await app.store.readPageHtml(page), /原内容/);
  assert.equal(app.store.getPage(page.id).revision, 1);
  for (const directory of [path.dirname(page.sourcePath), path.dirname(page.generatedPath)])
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith(".tmp")), false);
});

test("editing and replacement remain available after an uploaded source directory is lost", async t => {
  const { app, page, cookie } = await fixture(t);
  await app.store.saveSettings({ trackingCode: '<script data-tracking>window.tracking=true;</script>' });
  await fs.rm(path.dirname(page.sourcePath), { recursive: true });
  const saved = await app.inject({ method: "PATCH", url: `/admin/api/pages/${page.id}/content`, headers: { cookie }, payload: { html: replacement, revision: 1 } });
  assert.equal(saved.statusCode, 200, saved.body);
  const replaced = await replace(app, { ...page, revision: 2 }, cookie);
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.match(await app.store.readPageHtml(page), /data-tracking/);
});

test("replacement fails before changing files when original file ownership cannot be preserved", async t => {
  const { app, page, cookie } = await fixture(t);
  const stat = fs.stat.bind(fs);
  let requestedOwner;
  t.mock.method(fs, "stat", async (file, ...args) => {
    const value = await stat(file, ...args);
    return file === page.sourcePath ? Object.assign(value, { uid: value.uid + 1 }) : value;
  });
  t.mock.method(fs, "chown", async (file, uid, gid) => {
    requestedOwner = { uid, gid };
    throw Object.assign(new Error("Simulated ownership permission denial"), { code: "EPERM" });
  });
  const before = await stat(page.sourcePath);
  const response = await replace(app, page, cookie);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(requestedOwner, { uid: before.uid + 1, gid: before.gid });
  assert.equal(await fs.readFile(page.sourcePath, "utf8"), original);
  assert.match(await app.store.readPageHtml(page), /原内容/);
  assert.equal(app.store.getPage(page.id).revision, 1);
});

test("a database failure after replacement restores both files and keeps the old revision", async t => {
  const { app, page, cookie } = await fixture(t);
  const generated = await app.store.readPageHtml(page);
  app.store.db.exec(`CREATE TRIGGER reject_html_save BEFORE UPDATE OF title ON pages BEGIN SELECT RAISE(ABORT, 'Simulated database write failure'); END;`);
  const response = await replace(app, page, cookie);
  assert.equal(response.statusCode, 500);
  assert.equal(await fs.readFile(page.sourcePath, "utf8"), original);
  assert.equal(await app.store.readPageHtml(page), generated);
  assert.equal(app.store.getPage(page.id).revision, 1);
});

test("a resource-index failure rolls back page metadata and both HTML files", async t => {
  const { app, page, cookie } = await fixture(t);
  const generated = await app.store.readPageHtml(page);
  const register = app.store.access.registerResources.bind(app.store.access);
  let calls = 0;
  t.mock.method(app.store.access, "registerResources", (...args) => {
    register(...args);
    if (++calls === 2) throw new Error("Simulated resource index write failure");
  });
  const response = await replace(app, page, cookie);
  assert.equal(response.statusCode, 500);
  assert.equal(app.store.getPage(page.id).revision, 1);
  assert.equal(await fs.readFile(page.sourcePath, "utf8"), original);
  assert.equal(await app.store.readPageHtml(page), generated);
});

test("rollback preserves an external source edit made while replacement was failing", async t => {
  const { app, page, cookie } = await fixture(t);
  const external = '<title>外部修改</title><h1>外部新内容需要保留</h1>';
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === page.generatedPath) {
      await fs.writeFile(page.sourcePath, external);
      throw Object.assign(new Error("Simulated generated write failure"), { code: "EIO" });
    }
    return rename(from, to);
  });
  const response = await replace(app, page, cookie);
  assert.equal(response.statusCode, 500);
  assert.equal(await fs.readFile(page.sourcePath, "utf8"), external);
  assert.equal(app.store.getPage(page.id).revision, 1);
});

test("an interrupted nested attachment scan retains private ownership", async t => {
  const { app, cookie } = await fixture(t);
  const [privatePage, publicPage] = await app.store.importUploadFiles([
    { fileName: "private.html", relativePath: "private.html", buffer: Buffer.from('<script>fetch("secret.json")</script><h1>私有文档</h1>') },
    { fileName: "public.html", relativePath: "public.html", buffer: Buffer.from('<h1>公开文档</h1>') },
    { fileName: "00-rotate.txt", relativePath: "00-rotate.txt", buffer: Buffer.from("rotate") },
    { fileName: "secret.json", relativePath: "secret.json", buffer: Buffer.from('{"secret":"private data"}') },
  ]);
  await app.store.access.update(privatePage.id, { visibility: "private" });
  const sourceRoot = path.dirname(privatePage.sourcePath);
  const secretPath = path.join(sourceRoot, "secret.json");
  const secret = await fs.realpath(secretPath);
  assert.ok(app.store.db.prepare("SELECT 1 FROM page_resources WHERE page_id=? AND resource_path=?").get(privatePage.id, secret));
  const readdir = fs.readdir.bind(fs);
  let interrupted = false;
  t.mock.method(fs, "readdir", async (directory, ...args) => {
    const entries = await readdir(directory, ...args);
    if (directory === sourceRoot && !interrupted) {
      interrupted = true;
      await fs.unlink(path.join(sourceRoot, "00-rotate.txt"));
      entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    return entries;
  });
  const saved = await app.inject({ method: "PATCH", url: `/admin/api/pages/${privatePage.id}/content`, headers: { cookie }, payload: { html: '<script>fetch("secret.json")</script><h1>新私有文档</h1>', revision: 1 } });
  assert.equal(saved.statusCode, 500);
  assert.ok(app.store.db.prepare("SELECT 1 FROM page_resources WHERE page_id=? AND resource_path=?").get(privatePage.id, secret));
  const publicSave = await app.inject({ method: "PATCH", url: `/admin/api/pages/${publicPage.id}/content`, headers: { cookie }, payload: { html: '<a href="secret.json">公开引用</a>', revision: 1 } });
  assert.equal(publicSave.statusCode, 409);
  const relative = path.relative(app.config.uploadsDir, secretPath).split(path.sep).map(encodeURIComponent).join("/");
  const assetUrl = `/page-assets/${relative}`;
  assert.equal((await app.inject({ url: assetUrl })).statusCode, 404);
  assert.equal((await app.inject({ url: assetUrl, headers: { cookie } })).statusCode, 200);
});

test("watch imports wait for replacement and reread the committed source without adding duplicate revisions", async t => {
  const { app, dataDir } = await fixture(t);
  const directory = path.join(dataDir, "concurrent-watch");
  await app.store.addWatchDir({ path: directory, allowWrite: true });
  const source = path.join(directory, "watched.html");
  await fs.writeFile(source, original);
  const page = await app.store.upsertWatchedFile(source);
  const rename = fs.rename.bind(fs), stat = fs.stat.bind(fs);
  let renamed, release;
  const sourceRenamed = new Promise(resolve => { renamed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let watchRequested = false, touchedDuringSave = false;
  t.mock.method(fs, "rename", async (from, to) => {
    await rename(from, to);
    if (to === source && !watchRequested) { renamed(); await gate; }
  });
  t.mock.method(fs, "stat", (...args) => {
    if (args[0] === source && watchRequested) touchedDuringSave = true;
    return stat(...args);
  });
  const saving = app.store.replacePageHtml(page.id, { buffer: Buffer.from(replacement), fileName: "new.html", revision: 1 });
  await sourceRenamed;
  watchRequested = true;
  const watching = app.store.upsertWatchedFile(source);
  const readBeforeCommit = touchedDuringSave;
  release();
  await Promise.all([saving, watching]);
  assert.equal(readBeforeCommit, false);
  assert.equal(app.store.getPage(page.id).revision, 2);
  assert.equal(app.store.listVersions(page.id).length, 1);
});

test("a temporarily missing upload root retains private script attachment ownership after restoration", async t => {
  const { app, cookie } = await fixture(t);
  const [privatePage, publicPage] = await app.store.importUploadFiles([
    { fileName: "private.html", relativePath: "private.html", buffer: Buffer.from('<script>fetch("secret.json")</script><h1>私有文档</h1>') },
    { fileName: "public.html", relativePath: "public.html", buffer: Buffer.from('<h1>公开文档</h1>') },
    { fileName: "secret.json", relativePath: "secret.json", buffer: Buffer.from('{"secret":"private data"}') },
  ]);
  await app.store.access.update(privatePage.id, { visibility: "private" });
  const root = path.dirname(privatePage.sourcePath), offline = `${root}-offline`;
  await fs.rename(root, offline);
  const saved = await app.inject({ method: "PATCH", url: `/admin/api/pages/${privatePage.id}/content`, headers: { cookie }, payload: { html: '<script>fetch("secret.json")</script><h1>更新</h1>', revision: 1 } });
  assert.equal(saved.statusCode, 200, saved.body);
  const shared = await app.inject({ method: "PATCH", url: `/admin/api/pages/${publicPage.id}/content`, headers: { cookie }, payload: { html: '<a href="secret.json">公开引用</a>', revision: 1 } });
  assert.equal(shared.statusCode, 409);
  await fs.rename(offline, root);
  const url = `/page-assets/${path.basename(root)}/secret.json`;
  assert.equal((await app.inject({ url })).statusCode, 404);
  assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 200);
});

test("rollback rechecks ownership after staging its previous content", async t => {
  const { app, page, cookie } = await fixture(t);
  const external = '<h1>回退暂存期间的外部修改</h1>';
  const rename = fs.rename.bind(fs), writeFile = fs.writeFile.bind(fs);
  let rollingBack = false, externalWritten = false;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === page.generatedPath) { rollingBack = true; throw new Error("Simulated generated write failure"); }
    return rename(from, to);
  });
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    await writeFile(file, ...args);
    if (rollingBack && file.startsWith(page.sourcePath + ".") && file.endsWith(".tmp")) {
      await writeFile(page.sourcePath, external);
      externalWritten = true;
    }
  });
  const result = await replace(app, page, cookie);
  assert.equal(result.statusCode, 500);
  assert.equal(externalWritten, true);
  assert.equal(await fs.readFile(page.sourcePath, "utf8"), external);
});

test("a queued unlink event does not mark a source recreated by replacement as missing", async t => {
  const { app, dataDir } = await fixture(t);
  const directory = path.join(dataDir, "unlink-watch");
  await app.store.addWatchDir({ path: directory, allowWrite: true });
  const source = path.join(directory, "watched.html");
  await fs.writeFile(source, original);
  const page = await app.store.upsertWatchedFile(source);
  const rename = fs.rename.bind(fs);
  let deletion;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === source) {
      await fs.unlink(source);
      deletion = app.store.markSourceDeleted(source);
    }
    return rename(from, to);
  });
  await app.store.replacePageHtml(page.id, { fileName: "new.html", buffer: Buffer.from(replacement), revision: 1 });
  await deletion;
  assert.match(await fs.readFile(source, "utf8"), /替换后的内容/);
  assert.equal(app.store.getPage(page.id).status, "edited");
});

test("a failed resource reservation preserves the complete previous private attachment index", async t => {
  const { app, cookie } = await fixture(t);
  const [privatePage, publicPage] = await app.store.importUploadFiles([
    { fileName: "private.html", relativePath: "private.html", buffer: Buffer.from('<script>fetch("secret.json")</script><h1>私有文档</h1>') },
    { fileName: "public.html", relativePath: "public.html", buffer: Buffer.from('<h1>公开文档</h1>') },
    { fileName: "secret.json", relativePath: "secret.json", buffer: Buffer.from('{"secret":"private data"}') },
  ]);
  await app.store.access.update(privatePage.id, { visibility: "private" });
  const before = app.store.db.prepare("SELECT resource_path FROM page_resources WHERE page_id=?").all(privatePage.id);
  assert.equal(before.length, 1);
  app.store.db.exec(`CREATE TRIGGER reject_reservation BEFORE INSERT ON page_resources WHEN NEW.page_id='${privatePage.id}' BEGIN SELECT RAISE(ABORT, 'Simulated attachment index failure'); END;`);
  const saved = await app.inject({ method: "PATCH", url: `/admin/api/pages/${privatePage.id}/content`, headers: { cookie }, payload: { html: '<script>fetch("secret.json")</script><h1>修改</h1>', revision: 1 } });
  assert.equal(saved.statusCode, 500);
  assert.deepEqual(app.store.db.prepare("SELECT resource_path FROM page_resources WHERE page_id=?").all(privatePage.id), before);
  const shared = await app.inject({ method: "PATCH", url: `/admin/api/pages/${publicPage.id}/content`, headers: { cookie }, payload: { html: '<a href="secret.json">公开引用</a>', revision: 1 } });
  assert.equal(shared.statusCode, 409);
});
