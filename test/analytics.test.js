import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/server.js";
import { createDb } from "../src/db.js";
import { analyticsWindow } from "../src/analytics.js";

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "liekan-analytics-"));
  const config = { dataDir, uploadsDir: path.join(dataDir, "uploads"), generatedDir: path.join(dataDir, "pages"), versionsDir: path.join(dataDir, "versions"), publicDir: path.resolve("public"), watchDirs: [], ...overrides };
  const app = await buildApp(config);
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const cookie = `tokdoc_session=${app.store.createSessionToken("admin")}`;
  const create = (name = "note.html", buffer = Buffer.from("<title>测试文档</title><p>阅读正文</p>")) => app.store.importBuffer({ fileName: name, buffer });
  return { app, store: app.store, config, cookie, create };
}

test("analytics calendar follows local midnight, fractional offsets and DST", () => {
  const shanghai = analyticsWindow({ days: 7, timeZone: "Asia/Shanghai" }, new Date("2026-10-25T16:00:00Z"));
  assert.equal(shanghai.today, "2026-10-26");
  assert.equal(shanghai.todayStart, "2026-10-25T16:00:00.000Z");
  assert.equal(shanghai.buckets.length, 7);
  for (const [now, hours] of [["2026-03-08T16:00:00Z", 23], ["2026-11-01T16:00:00Z", 25]]) {
    const ny = analyticsWindow({ days: 7, timeZone: "America/New_York" }, new Date(now));
    assert.equal((Date.parse(ny.end) - Date.parse(ny.todayStart)) / 3600000, hours);
  }
  const kathmandu = analyticsWindow({ timeZone: "Asia/Kathmandu" }, new Date("2026-10-25T12:00:00Z"));
  assert.equal(kathmandu.todayStart, "2026-10-24T18:15:00.000Z");
  const skippedMidnight = analyticsWindow({ timeZone: "America/Sao_Paulo", days: 7 }, new Date("2018-11-04T12:00:00Z"));
  assert.equal(skippedMidnight.todayStart, "2018-11-04T03:00:00.000Z");
  for (const query of [{ days: 100000 }, { days: "bad" }, { timeZone: "broken/timezone" }]) assert.throws(() => analyticsWindow(query), { statusCode: 400 });
});

test("daily trends, rankings and totals preserve history across deletion and restart", async t => {
  const { store, create, config } = await fixture(t);
  store.setSetting("analytics_started_at", "2026-10-01T00:00:00.000Z");
  const a = await create("a.html"), b = await create("b.html"), c = await create("c.pdf", Buffer.from("%PDF-1.4\n%%EOF"));
  store.db.prepare("UPDATE pages SET access_count = 42 WHERE id = ?").run(a.id);
  store.analytics.record(a.id, "2026-10-24T15:59:59.999Z");
  for (let i = 0; i < 3; i++) store.analytics.record(b.id, "2026-10-24T16:00:00.000Z");
  store.analytics.record(c.id, "2026-10-25T15:59:59.999Z");
  store.analytics.record(a.id, "2026-10-25T16:00:00.000Z");
  await store.deletePage(b.id);
  const report = store.analytics.report({ days: 7, timeZone: "Asia/Shanghai" }, new Date("2026-10-25T12:00:00Z"));
  assert.equal(report.summary.todayViews, 4);
  assert.equal(report.summary.yesterdayViews, 1);
  assert.equal(report.summary.totalViews, 48);
  assert.equal(report.summary.periodViews, 5);
  assert.equal(report.summary.periodDocuments, 3);
  assert.equal(report.trend.length, 7);
  assert.deepEqual(report.trend.at(-1), { date: "2026-10-25", views: 4, documents: 2 });
  assert.deepEqual(report.rankings.today.pages.map(row => [row.id, row.views, row.deleted]), [[b.id, 3, true], [c.id, 1, false]]);
  assert.equal(report.rankings.total.pages[0].id, a.id);
  assert.equal(report.rankings.total.pages[0].views, 44);
  assert.deepEqual(report.byType, { html: 4, pdf: 1, word: 0, other: 0 });
  assert.equal(store.managementSummary({ q: "missing", type: "word", dayStart: "2026-10-24T16:00:00.000Z", dayEnd: "2026-10-25T16:00:00.000Z" }).stats.todayViews, 4);
  await store.restoreDeletedPage(b.id);
  assert.equal(store.analytics.report({ timeZone: "Asia/Shanghai", days: 7 }, new Date("2026-10-25T12:00:00Z")).summary.totalViews, 48);
  const reopened = createDb(config);
  try {
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM page_views").get().count, 6);
    assert.equal(reopened.prepare("SELECT value FROM settings WHERE key='analytics_started_at'").get().value, "2026-10-01T00:00:00.000Z");
  } finally { reopened.close(); }
});

test("empty analytics distinguish unrecorded history from zero and paginate deterministic rankings", async t => {
  const { store, create } = await fixture(t);
  store.setSetting("analytics_started_at", "2026-10-25T10:00:00.000Z");
  const query = { days: 7, timeZone: "Asia/Shanghai" };
  const now = new Date("2026-10-25T12:00:00Z");
  const empty = store.analytics.report(query, now);
  assert.equal(empty.summary.totalViews, 0);
  assert.equal(empty.summary.yesterdayAvailable, false);
  assert.equal(empty.trend[0].views, null);
  assert.equal(empty.trend.at(-1).views, 0);
  assert.deepEqual(empty.rankings.today.pages, []);
  for (let i = 0; i < 12; i++) {
    const page = await create(`${String(i).padStart(2, "0")}.html`);
    store.analytics.record(page.id, "2026-10-25T11:00:00.000Z");
  }
  const first = store.analytics.report(query, now);
  const last = store.analytics.report({ ...query, totalPage: 999, todayPage: 2 }, now);
  assert.equal(first.rankings.total.pages.length, 10);
  assert.equal(last.rankings.total.pages.length, 2);
  assert.equal(last.rankings.total.pages[0].rank, 11);
  assert.equal(last.rankings.total.pagination.page, 2);
  assert.equal(new Set([...first.rankings.total.pages, ...last.rankings.total.pages].map(row => row.id)).size, 12);
  assert.equal(last.summary.dailyAverage, 12);
  assert.throws(() => store.analytics.report({ ...query, totalPage: "1;DROP TABLE pages" }, now), { statusCode: 400 });
});

test("yesterday comparison distinguishes a partial first day from a full natural day", async t => {
  const { store, create } = await fixture(t);
  const page = await create();
  const now = new Date("2026-10-26T12:00:00.000Z");
  const query = { days: 7, timeZone: "Asia/Shanghai" };
  store.setSetting("analytics_started_at", "2026-10-25T15:59:59.000Z");
  store.analytics.record(page.id, "2026-10-25T15:59:59.500Z");
  for (let i = 0; i < 10; i++) store.analytics.record(page.id, "2026-10-25T17:00:00.000Z");
  const partial = store.analytics.report(query, now).summary;
  assert.equal(partial.yesterdayViews, 1);
  assert.equal(partial.todayViews, 10);
  assert.equal(partial.yesterdayAvailable, true);
  assert.equal(partial.yesterdayComplete, false, "a one-second first day cannot support a full-day comparison");
  store.setSetting("analytics_started_at", "2026-10-24T16:00:00.000Z");
  const full = store.analytics.report(query, now).summary;
  assert.equal(full.yesterdayComplete, true, "recording from local midnight covers the complete natural day");
});

test("only successful reading GETs count, including PDF and legacy URLs", async t => {
  const { app, store, cookie, create, config } = await fixture(t);
  const html = await create(), pdf = await create("read.pdf", Buffer.from("%PDF-1.4\n%%EOF"));
  await app.inject({ method: "HEAD", url: html.url });
  await app.inject({ url: html.editUrl, headers: { cookie } });
  await app.inject({ url: `${pdf.url}?edit=1`, headers: { cookie } });
  await app.inject({ method: "HEAD", url: pdf.url });
  const raw = "/page-assets/" + path.relative(config.uploadsDir, html.sourcePath).split(path.sep).join("/");
  await app.inject(raw);
  assert.equal(store.analytics.summary("2000", "2100").totalViews, 0);
  for (const url of [html.url, `/pages/${html.slug}.html`, pdf.url]) assert.equal((await app.inject(url)).statusCode, 200);
  assert.equal(store.analytics.summary("2000", "2100").todayViews, 3);
  await fs.rm(html.generatedPath);
  assert.equal((await app.inject(html.url)).statusCode, 500);
  assert.equal(store.getPage(html.id).accessCount, 2);
  const locked = await create("locked.html");
  await app.inject({ method: "PATCH", url: `/admin/api/pages/${locked.id}/access`, headers: { cookie }, payload: { passwordAction: "set", password: "test-password" } });
  await app.inject(locked.url);
  assert.equal(store.getPage(locked.id).accessCount, 0);
  const unlocked = await app.inject({ method: "POST", url: `/public/api/documents/${locked.slug}/unlock`, headers: { origin: "http://localhost:80" }, payload: { password: "test-password" } });
  assert.equal(unlocked.statusCode, 200);
  const readerCookie = String(unlocked.headers["set-cookie"]).split(";")[0];
  await app.inject({ url: locked.url, headers: { cookie: readerCookie } });
  assert.equal(store.getPage(locked.id).accessCount, 1);
});

test("analytics APIs require admin authentication and follow a custom admin path", async t => {
  const { app, cookie } = await fixture(t, { adminPathOverride: "/ops" });
  assert.equal((await app.inject("/ops/api/analytics")).statusCode, 401);
  for (const url of ["/api/analytics", "/admin/api/analytics"]) assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 404);
  for (const suffix of ["days=8", "timeZone=bad", "totalPage=-1"]) assert.equal((await app.inject({ url: `/ops/api/analytics?${suffix}`, headers: { cookie } })).statusCode, 400);
  const report = await app.inject({ url: "/ops/api/analytics?days=7&timeZone=Asia%2FShanghai", headers: { cookie } });
  assert.equal(report.statusCode, 200);
  assert.equal(report.headers["cache-control"], "no-store");
  assert.equal(report.json().trend.length, 7);
  assert.equal(Object.hasOwn((await app.inject("/public/api/pages")).json(), "rankings"), false);
  assert.equal((await app.inject("/ops/api/analytics/rankings?mode=total")).statusCode, 401);
  assert.equal((await app.inject({ url: "/admin/api/analytics/rankings?mode=total", headers: { cookie } })).statusCode, 404);
  const details = await app.inject({ url: "/ops/api/analytics/rankings?mode=today&timeZone=Asia%2FShanghai", headers: { cookie } });
  assert.equal(details.statusCode, 200);
  assert.equal(details.headers["cache-control"], "no-store");
  assert.equal(details.json().pagination.pageSize, 20);
  assert.equal((await app.inject({ url: "/ops/api/analytics/rankings?mode=unknown", headers: { cookie } })).statusCode, 400);
});

test("ranking details include every ranked document with independent 20-row pagination and precise counts", async t => {
  const { store, create } = await fixture(t);
  store.setSetting("analytics_started_at", "2026-10-01T00:00:00.000Z");
  const now = new Date("2026-10-26T12:00:00.000Z");
  const documents = [];
  for (let i = 0; i < 24; i++) {
    const doc = await create(`rank-${i}.html`);
    documents.push(doc);
    for (let v = 0; v < 24 - i; v++) store.analytics.record(doc.id, "2026-10-25T16:00:00.000Z");
  }
  await create("not-viewed.html");
  store.db.prepare("UPDATE pages SET access_count = ? WHERE id = ?").run(123456789, documents[20].id);
  await store.deletePage(documents[23].id);
  const query = { mode: "today", timeZone: "Asia/Shanghai" };
  const first = store.analytics.rankingDetails(query, now);
  const last = store.analytics.rankingDetails({ ...query, page: 999 }, now);
  assert.equal(first.pages.length, 20);
  assert.equal(first.pagination.total, 24);
  assert.equal(first.views, 300);
  assert.equal(last.pages.length, 4);
  assert.equal(last.pagination.page, 2);
  assert.equal(last.pagination.offset, 20);
  assert.equal(last.pages[0].rank, 21);
  assert.equal(last.pages.at(-1).deleted, true);
  assert.equal(new Set([...first.pages, ...last.pages].map(doc => doc.id)).size, 24);
  const cumulative = store.analytics.rankingDetails({ ...query, mode: "total" }, now);
  assert.equal(cumulative.pages[0].views, 123456789);
  assert.equal(cumulative.pages[0].id, documents[20].id);
  assert.equal(cumulative.views, 123456789 + 296);
  const overview = store.analytics.report({ timeZone: query.timeZone }, now);
  assert.equal(overview.rankings.total.pages.length, 10);
  assert.equal(overview.rankings.today.pages.length, 10);
  for (const invalid of [{ mode: "none" }, { ...query, page: 0 }, { ...query, page: "Infinity" }, { ...query, timeZone: "invalid" }]) {
    assert.throws(() => store.analytics.rankingDetails(invalid, now), { statusCode: 400 });
  }
});
