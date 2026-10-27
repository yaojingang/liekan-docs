import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildApp } from "../src/server.js";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "liekan-download-"));
  const app = await buildApp({
    name: "liekan-docs", rootDir: dataDir, dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    generatedDir: path.join(dataDir, "pages"),
    versionsDir: path.join(dataDir, "versions"),
    publicDir: path.resolve("public"), watchDirs: [], allowSourceWrite: false,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const token = app.store.createSessionToken("admin");
  const headers = { cookie: `tokdoc_session=${token}` };
  return { app, dataDir, headers };
}

test("admin downloads original HTML, PDF and Word bytes with their original filenames", async (t) => {
  const { app, headers } = await fixture(t);
  app.store.convertWordToPdf = async (_source, target) => fs.writeFile(target, "%PDF-converted");
  for (const [fileName, buffer] of [
    ["中文 报告.html", Buffer.from("<title>Original</title><h1>Original source</h1>")],
    ["报告.pdf", Buffer.from("%PDF-1.4\n\x00\xff", "latin1")],
    ["合同.docx", Buffer.from("PK\x03\x04original-word\x00", "latin1")],
    ["旧合同.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0xff])],
  ]) {
    const page = await app.store.importBuffer({ fileName, buffer });
    if (page.fileType === "html") await app.store.savePageContent(page.id, {
      html: "<title>Edited</title><h1>Saved online</h1>", revision: page.revision,
    });
    const url = `/admin/api/pages/${page.id}/download`;
    const result = await app.inject({ url, headers });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.rawPayload, buffer);
    assert.match(result.headers["content-disposition"], /^attachment; filename="[\w.-]+";/);
    assert.ok(result.headers["content-disposition"].endsWith(`filename*=UTF-8''${encodeURIComponent(fileName)}`));
    assert.equal(result.headers["content-type"], "application/octet-stream");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
    const head = await app.inject({ method: "HEAD", url, headers });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(Number(head.headers["content-length"]), buffer.length);
    const ranged = await app.inject({ url, headers: { ...headers, range: "bytes=0-3" } });
    assert.equal(ranged.statusCode, 200);
    assert.deepEqual(ranged.rawPayload, buffer);
    assert.equal(app.store.getPage(page.id).accessCount, 0);
  }
});

test("downloads require admin login for every visibility and follow the configured admin path", async (t) => {
  const { app, headers } = await fixture(t);
  const page = await app.store.importBuffer({ fileName: "secret.html", buffer: Buffer.from("<h1>secret</h1>") });
  const url = `/admin/api/pages/${page.id}/download`;
  for (const policy of [
    { visibility: "public", homepageListed: true, passwordAction: "keep" },
    { visibility: "public", homepageListed: false, passwordAction: "keep" },
    { visibility: "public", passwordAction: "set", password: "read-secret" },
    { visibility: "private", passwordAction: "remove" },
  ]) {
    await app.store.access.update(page.id, policy);
    for (const method of ["GET", "HEAD"]) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
      assert.equal((await app.inject({ method, url, headers })).statusCode, 200);
    }
  }
  await app.store.saveSettings({ adminPath: "/my-admin" });
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/pages/${page.id}/download`, headers })).statusCode, 404);
  const customUrl = `/my-admin/api/pages/${page.id}/download`;
  assert.equal((await app.inject(customUrl)).statusCode, 401);
  assert.equal((await app.inject({ url: customUrl, headers })).statusCode, 200);
  for (const id of ["missing", "%2e%2e%2fsecret", "%2fetc%2fpasswd"]) {
    assert.equal((await app.inject({ url: `/my-admin/api/pages/${id}/download`, headers })).statusCode, 404);
  }
});

test("download handles watched files, samples, missing originals and deleted documents", async (t) => {
  const { app, dataDir, headers } = await fixture(t);
  const watchDir = path.join(dataDir, "watch");
  await fs.mkdir(watchDir);
  await app.store.addWatchDir({ path: watchDir });
  const source = path.join(watchDir, "watched.html");
  await fs.writeFile(source, "<title>Watched</title>");
  const page = await app.store.upsertWatchedFile(source);
  const url = `/admin/api/pages/${page.id}/download`;
  assert.equal((await app.inject({ url, headers })).body, "<title>Watched</title>");
  await fs.rm(source);
  const missing = await app.inject({ url, headers });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /源文件/);
  assert.ok(!missing.body.includes(dataDir));
  const [sample] = await app.store.addSamplePages();
  const sampleUrl = `/admin/api/pages/${sample.id}/download`;
  assert.deepEqual((await app.inject({ url: sampleUrl, headers })).rawPayload, await app.store.readPageFile(sample));
  await app.store.deletePage(sample.id);
  assert.equal((await app.inject({ url: sampleUrl, headers })).statusCode, 404);
  await fs.writeFile(source, "<title>Original still exists</title>");
  await app.store.deletePage(page.id);
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
});

test("download menu saves a browser file and reports missing sources without navigating away", async () => {
  const source = await fs.readFile("public/app.js", "utf8");
  const fragment = source.slice(source.indexOf("async function downloadPage("), source.indexOf("async function mutatePage("));
  const saved = [], messages = [], requests = [], revoked = [];
  let result = { ok: true, blob: async () => new Blob(["original"]) };
  const context = vm.createContext({
    sessionEpoch: 1, session: true,
    apiUrl: value => `/my-admin${value}`, encodeURIComponent,
    fetch: async (url, options) => { requests.push({ url, options }); return result; },
    URL: { createObjectURL: blob => { assert.equal(blob.size, 8); return "blob:source"; }, revokeObjectURL: url => revoked.push(url) },
    document: { body: { append() {} }, createElement: () => ({ click() { saved.push({ href: this.href, name: this.download }); }, remove() {} }) },
    setTimeout: fn => fn(), toast: message => messages.push(message), showLogin: message => messages.push(message),
  });
  vm.runInContext(fragment, context);
  const menu = vm.runInContext('menuItems({id:"doc-id",fileName:"中文 报告.docx",canEdit:false,canSync:false})', context);
  const download = menu.find(item => item.label === "下载源文件");
  assert.ok(download);
  await download.run();
  assert.equal(requests[0].url, "/my-admin/api/pages/doc-id/download");
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.deepEqual(saved, [{ href: "blob:source", name: "中文 报告.docx" }]);
  assert.deepEqual(revoked, ["blob:source"]);
  result = { ok: false, status: 404, json: async () => ({ error: "源文件不存在，暂时无法下载" }) };
  await download.run();
  assert.equal(saved.length, 1);
  assert.match(messages.at(-1), /源文件不存在/);
  result = { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) };
  await download.run();
  assert.match(messages.at(-2), /登录已失效/);
  result = { ok: true, blob: async () => { context.sessionEpoch++; return new Blob(["original"]); } };
  await download.run();
  assert.equal(saved.length, 1, "an expired session response must not trigger a download");
});
