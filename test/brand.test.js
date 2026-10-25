import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHTML } from "linkedom";
import { buildApp } from "../src/server.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "liekan-brand-"));
  const config = { dataDir, uploadsDir: path.join(dataDir, "uploads"), generatedDir: path.join(dataDir, "pages"), versionsDir: path.join(dataDir, "versions"), publicDir: path.resolve("public"), watchDirs: [], ...overrides };
  const app = await buildApp(config);
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, cookie: `tokdoc_session=${app.store.createSessionToken("admin")}` };
}
function multipart(bytes, fileName = "brand.png", type = "image/png") {
  const boundary = "liekan-logo-boundary";
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test("brand text, subtitle and uploaded image persist and render with escaped public markup", async t => {
  const { app, cookie } = await fixture(t);
  assert.equal(app.store.getSettings().publicBrandCaption, "DOCUMENT WORKSPACE");
  const upload = await app.inject({ method: "POST", url: "/admin/api/brand/logo", ...multipart(png), headers: { ...multipart(png).headers, cookie } });
  assert.equal(upload.statusCode, 200, upload.body);
  const url = upload.json().url;
  assert.match(url, /^\/public\/brand\/logo-[a-f0-9]{32}\.png$/);
  const settings = { siteName: '资料 $& <b>小站</b>', publicBrandCaption: 'TEAM <b>KNOWLEDGE</b> $&', publicLogoUrl: url };
  const saved = await app.inject({ method: "PATCH", url: "/admin/api/settings", headers: { cookie }, payload: settings });
  assert.equal(saved.statusCode, 200);
  for (const pageUrl of ["/", "/?view=resources", "/type/html"]) {
    const page = await app.inject({ url: pageUrl });
    const { document } = parseHTML(page.body);
    assert.equal(document.querySelector(".brand-title").textContent, settings.siteName);
    assert.equal(document.querySelector(".brand-caption").textContent, settings.publicBrandCaption);
    assert.equal(document.querySelector(".brand-copy b"), null);
    assert.equal(document.querySelector("#publicLogoImage").getAttribute("src"), url);
  }
  const image = await app.inject({ url });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["x-content-type-options"], "nosniff");
  assert.match(image.headers["cache-control"], /immutable/);
  assert.deepEqual(image.rawPayload, png);
  assert.equal((await app.inject({ method: "HEAD", url })).body, "");
  assert.equal(app.store.managementSummary().stats.all, 0);
  const reset = await app.inject({ method: "PATCH", url: "/admin/api/settings", headers: { cookie }, payload: { publicLogoUrl: "", publicBrandCaption: "" } });
  assert.equal(reset.statusCode, 200);
  const { document } = parseHTML((await app.inject({ url: "/" })).body);
  assert.equal(document.querySelector("#publicLogoImage, .brand-caption"), null);
  assert.ok(document.querySelector(".brand-symbol[data-icon=document]"));
  assert.equal((await app.inject({ url })).statusCode, 200, "restoring the icon must preserve existing image URLs");
});

test("logo uploads enforce authentication, actual image format, size and fixed public filenames", async t => {
  const { app, cookie } = await fixture(t, { adminPathOverride: "/workspace" });
  const upload = async (bytes, fileName, type, authenticated = true, prefix = "/workspace") => {
    const body = multipart(bytes, fileName, type);
    return app.inject({ method: "POST", url: `${prefix}/api/brand/logo`, ...body, headers: { ...body.headers, ...(authenticated ? { cookie } : {}) } });
  };
  assert.equal((await upload(png, "brand.png", "image/png", false)).statusCode, 401);
  assert.equal((await upload(png, "brand.png", "image/png", true, "/admin")).statusCode, 404);
  assert.equal((await upload(Buffer.from('<svg onload="alert(1)"></svg>'), "brand.svg", "image/png")).statusCode, 400);
  assert.equal((await upload(Buffer.from("<script>alert(1)</script>"), "brand.jpg", "image/jpeg")).statusCode, 400);
  assert.equal((await upload(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]), "brand.png", "image/png")).statusCode, 413);
  const responses = await Promise.all(Array.from({ length: 3 }, () => upload(png, "../../brand.png", "text/html")));
  assert.ok(responses.every(response => response.statusCode === 200));
  assert.equal(new Set(responses.map(response => response.json().url)).size, 1);
  const url = responses[0].json().url;
  assert.deepEqual((await app.inject({ url })).rawPayload, png);
  assert.deepEqual(await fs.readdir(path.join(app.config.dataDir, "brand")), [path.basename(url)]);
  for (const file of ["..%2Ftokdoc.db", "secret.svg", `logo-${"a".repeat(32)}.png`]) assert.equal((await app.inject({ url: `/public/brand/${file}` })).statusCode, 404);
});

test("invalid brand settings are rejected before any other setting is written", async t => {
  const { app, cookie } = await fixture(t);
  const initial = app.store.getSettings();
  for (const settings of [
    ...["javascript:alert(1)", "data:image/png;base64,AAAA", "//example.com/logo.png", "/\\evil", "https://user:pass@example.com/logo.png", "https://example.com\n/logo.png"].map(publicLogoUrl => ({ publicLogoUrl })),
    { publicBrandCaption: "标".repeat(81) },
  ]) {
    const saved = await app.inject({ method: "PATCH", url: "/admin/api/settings", headers: { cookie }, payload: { siteName: "不可部分保存", ...settings } });
    assert.equal(saved.statusCode, 400, JSON.stringify(settings));
    assert.equal(app.store.getSettings().siteName, initial.siteName);
    assert.equal(app.store.getSettings().publicLogoUrl, "");
  }
  const saved = await app.inject({ method: "PATCH", url: "/admin/api/settings", headers: { cookie }, payload: { publicLogoUrl: " https://example.com/logo.png?x=1&y=2 ", publicBrandCaption: " 品牌说明 " } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().settings.publicLogoUrl, "https://example.com/logo.png?x=1&y=2");
  assert.equal(saved.json().settings.publicBrandCaption, "品牌说明");
});
