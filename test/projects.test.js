import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../src/server.js";
import { createDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { PageStore } from "../src/page-store.js";

async function setup(t, adminPath = "/admin") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "liekan-projects-"));
  const config = { ...loadConfig({ TOKDOC_DATA_DIR: dataDir, TOKDOC_ADMIN_PATH: adminPath }), watchDirs: [] };
  const app = await buildApp(config);
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const headers = { cookie: `tokdoc_session=${app.store.createSessionToken("admin")}` };
  const call = (method, endpoint, payload) => app.inject({ method, url: `${adminPath}/api${endpoint}`, headers, payload });
  return { app, store: app.store, config, call };
}

test("existing databases gain optional projects while preserving document metadata and URLs", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "liekan-project-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "tokdoc.db");
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE pages (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, title TEXT NOT NULL,
    source_type TEXT NOT NULL, source_path TEXT, directory_name TEXT, size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, generated_path TEXT NOT NULL, raw_mtime_ms INTEGER,
    checksum TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0
  ); INSERT INTO pages (id, slug, file_name, title, source_type, created_at, updated_at, generated_path, checksum)
    VALUES ('legacy', 'legacy', 'old.html', '原有文档', 'upload', '2026-01-01', '2026-01-01', 'old.html', 'hash');`);
  old.close();
  const config = { dataDir, dbPath };
  for (let round = 0; round < 2; round++) {
    const db = createDb(config);
    try {
      const store = new PageStore(config, db);
      const page = store.getPage("legacy");
      assert.equal(page.title, "原有文档");
      assert.equal(page.url, "/legacy");
      assert.equal(page.projectId, "");
      assert.equal(page.projectName, "默认项目");
      assert.equal(store.listPages({ projectId: "unassigned" }).length, 1);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  }
});

test("project APIs require login and respect a custom admin path", async t => {
  const { app, call } = await setup(t, "/workspace");
  for (const [method, url, payload] of [
    ["GET", "/projects"], ["POST", "/projects", { name: "未授权" }],
    ["PATCH", "/projects/no-id", { name: "未授权" }], ["DELETE", "/projects/no-id"],
    ["PATCH", "/pages/no-id/project", { projectId: "" }],
  ]) assert.equal((await app.inject({ method, url: "/workspace/api" + url, payload })).statusCode, 401);
  for (const url of ["/api/projects", "/admin/api/projects"]) assert.equal((await app.inject(url)).statusCode, 404);
  assert.equal((await call("POST", "/projects", { name: "客户项目" })).statusCode, 201);
  assert.equal((await call("GET", "/projects")).json().projects.length, 1);
});

test("projects validate names, reject duplicates and persist renames by stable ID", async t => {
  const { store, call, config } = await setup(t);
  for (const name of ["", "  ", "项".repeat(61), "bad\nname", 42, null]) {
    assert.equal((await call("POST", "/projects", { name })).statusCode, 400);
  }
  const created = await call("POST", "/projects", { name: "  猎看 GEO  " });
  assert.equal(created.statusCode, 201);
  const project = created.json().project;
  assert.equal(project.name, "猎看 GEO");
  assert.equal((await call("POST", "/projects", { name: "猎看 geo" })).statusCode, 409);
  const page = await store.importBuffer({ fileName: "proposal.html", buffer: Buffer.from("<title>方案</title>"), projectId: project.id });
  const updated = await call("PATCH", `/projects/${project.id}`, { name: "客户方案" });
  assert.equal(updated.statusCode, 200);
  assert.equal(store.getPage(page.id).projectName, "客户方案");
  assert.equal(store.getPage(page.id).url, page.url);
  const reopened = createDb(config);
  try {
    const other = new PageStore(config, reopened);
    assert.equal(other.getPage(page.id).projectId, project.id);
    assert.equal(other.getPage(page.id).projectName, "客户方案");
  } finally { reopened.close(); }
  assert.equal((await call("PATCH", "/projects/missing", { name: "名称" })).statusCode, 404);
});

test("default project is named consistently and cannot be shadowed by custom projects", async t => {
  const { store, call, app } = await setup(t);
  const page = await store.importBuffer({ fileName: "default.html", buffer: Buffer.from("<title>旧文档</title>") });
  const privatePage = await store.importBuffer({ fileName: "private-default.html", buffer: Buffer.from("<title>Private</title>"), visibility: "private" });
  assert.equal(page.projectName, "默认项目");
  const summary = (await call("GET", "/projects")).json();
  assert.deepEqual(summary.defaultProject, { id: "", name: "默认项目", documentCount: 2 });
  for (const name of ["默认项目", " 默认项目 "]) assert.equal((await call("POST", "/projects", { name })).statusCode, 409);
  const project = store.saveProject(null, "自定义项目");
  assert.equal((await call("PATCH", `/projects/${project.id}`, { name: "默认项目" })).statusCode, 409);
  assert.equal(store.listProjects()[0].name, "自定义项目");
  const pub = (await app.inject("/public/api/pages?projectId=unassigned")).json();
  assert.deepEqual(pub.pages.map(page => page.slug), [page.slug]);
  assert.equal(pub.pages[0].projectName, "默认项目");
  assert.equal(pub.pages.some(page => page.slug === privatePage.slug), false);
});

test("staged uploads validate every project before import and support different projects per file", async t => {
  const { store, call } = await setup(t);
  const one = store.saveProject(null, "文档系统");
  const two = store.saveProject(null, "客户报告");
  const batch = await store.stageUploadFiles([
    { fileName: "guide.html", relativePath: "manual/guide.html", buffer: Buffer.from("<title>使用指南</title>") },
    { fileName: "report.pdf", buffer: Buffer.from("%PDF-1.4\n") },
  ]);
  const edits = batch.documents.map((doc, i) => ({ id: doc.id, projectId: i ? "missing" : one.id }));
  const invalid = await call("POST", `/pages/upload/${batch.uploadId}/confirm`, { documents: edits });
  assert.equal(invalid.statusCode, 400);
  assert.equal(store.listPages().length, 0);
  edits[1].projectId = two.id;
  const confirmed = await call("POST", `/pages/upload/${batch.uploadId}/confirm`, { documents: edits });
  assert.equal(confirmed.statusCode, 201);
  assert.deepEqual(confirmed.json().pages.map(page => page.projectId), [one.id, two.id]);
  assert.equal(confirmed.json().pages[0].directoryName, "manual");
  const another = await store.stageUploadFiles([{ fileName: "later.html", buffer: Buffer.from("<title>Later</title>") }]);
  store.deleteProject(one.id);
  assert.equal((await call("POST", `/pages/upload/${another.uploadId}/confirm`, { documents: [{ id: another.documents[0].id, projectId: one.id }] })).statusCode, 400);
  assert.equal(store.listPages().length, 2);
});

test("multipart project selection survives preparation and partial confirmation edits", async t => {
  const { store, app, call } = await setup(t);
  const project = store.saveProject(null, "上传项目");
  const multipart = async (endpoint, projectId, fieldLast = false) => {
    const boundary = "project-upload-boundary";
    const field = `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${projectId}\r\n`;
    const file = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="prepared.html"\r\nContent-Type: text/html\r\n\r\n<title>Prepared</title>\r\n`;
    return app.inject({ method: "POST", url: "/admin/api/pages/upload" + endpoint,
      headers: { cookie: `tokdoc_session=${store.createSessionToken("admin")}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: (fieldLast ? file + field : field + file) + `--${boundary}--\r\n`,
    });
  };
  const invalid = await multipart("/prepare", "missing");
  assert.equal(invalid.statusCode, 400);
  assert.equal(store.listPages().length, 0);
  const prepared = await multipart("/prepare", project.id);
  assert.equal(prepared.statusCode, 201);
  const batch = prepared.json();
  assert.equal(batch.documents[0].projectId, project.id);
  const confirmed = await call("POST", `/pages/upload/${batch.uploadId}/confirm`, { documents: [{ id: batch.documents[0].id, title: "更新标题" }] });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(confirmed.json().pages[0].projectId, project.id);
  assert.equal(confirmed.json().pages[0].title, "更新标题");
  const direct = await multipart("", project.id, true);
  assert.equal(direct.statusCode, 201);
  assert.equal(direct.json().pages[0].projectId, project.id);
});

test("project filters compose with search, type, directory, pagination and trash", async t => {
  const { store, call } = await setup(t);
  const project = store.saveProject(null, "交付材料");
  for (let i = 0; i < 3; i++) await store.importBuffer({ fileName: `guide-${i}.html`, relativePath: `manual/guide-${i}.html`, buffer: Buffer.from(`<title>使用指南 ${i}</title>`), projectId: project.id });
  const plain = await store.importBuffer({ fileName: "plain.html", buffer: Buffer.from("<title>未分配</title>") });
  const pdf = await store.importBuffer({ fileName: "guide.pdf", buffer: Buffer.from("%PDF-1.4"), projectId: project.id });
  const result = (await call("GET", `/pages?projectId=${project.id}&type=html&q=指南&directory=manual&pageSize=2&page=2`)).json();
  assert.equal(result.pagination.total, 3);
  assert.equal(result.pages.length, 1);
  assert.equal(result.stats.all, 5);
  assert.deepEqual(result.facets.projects, [{ id: project.id, name: project.name, documentCount: 4 }]);
  assert.deepEqual(store.listPages({ projectId: "unassigned" }).map(page => page.id), [plain.id]);
  assert.equal(store.listPages({ projectId: "missing" }).length, 0);
  assert.equal((await call("PATCH", `/pages/${plain.id}/project`, { projectId: project.id })).json().page.projectName, project.name);
  assert.equal((await call("PATCH", `/pages/${plain.id}/project`, { projectId: "" })).json().page.projectId, "");
  assert.equal((await call("PATCH", `/pages/${plain.id}/project`, { projectId: "bad" })).statusCode, 400);
  assert.equal((await call("PATCH", `/pages/${plain.id}/project`, {})).statusCode, 400);
  assert.equal(store.getPage(plain.id).projectId, "");
  await store.deletePage(pdf.id);
  assert.deepEqual(store.listPages({ scope: "trash", projectId: project.id }).map(page => page.id), [pdf.id]);
  assert.equal((await call("PATCH", `/pages/${pdf.id}/project`, { projectId: "" })).statusCode, 404);
  await store.restoreDeletedPage(pdf.id);
  assert.equal(store.getPage(pdf.id).projectId, project.id);
});

test("deleting a project during Word conversion completes the batch with unassigned documents", async t => {
  const { store, call } = await setup(t);
  const project = store.saveProject(null, "正在转换的项目");
  store.convertWordToPdf = async (_source, generatedPath) => {
    store.deleteProject(project.id);
    await fs.writeFile(generatedPath, "%PDF-1.4");
  };
  const batch = await store.stageUploadFiles([
    { fileName: "first.html", buffer: Buffer.from("<title>First</title>") },
    { fileName: "second.docx", buffer: Buffer.from("Word converter fixture") },
  ]);
  const response = await call("POST", `/pages/upload/${batch.uploadId}/confirm`, {
    documents: batch.documents.map(document => ({ id: document.id, projectId: project.id })),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().pages.length, 2);
  assert.ok(response.json().pages.every(page => page.projectId === "" && page.projectName === "默认项目"));
  assert.ok(store.listPages().every(page => page.projectId === ""));
  await assert.rejects(store.readStagedUploadManifest(batch.uploadId), /Upload batch not found/);
});

test("public project options and counts include only listed public documents", async t => {
  const { store, app } = await setup(t);
  const visible = store.saveProject(null, "公开项目");
  const hidden = store.saveProject(null, "内部项目名称");
  const empty = store.saveProject(null, "空项目名称");
  const pub = await store.importBuffer({ fileName: "public.html", buffer: Buffer.from("<title>公开</title>"), projectId: visible.id });
  for (const mode of ["private", "unlisted", "trash"]) {
    const page = await store.importBuffer({ fileName: mode + ".html", buffer: Buffer.from(`<title>${mode}</title>`), projectId: hidden.id, visibility: mode === "private" ? "private" : "public" });
    if (mode === "unlisted") await store.access.update(page.id, { homepageListed: false });
    if (mode === "trash") await store.deletePage(page.id);
  }
  await store.importBuffer({ fileName: "secret.html", buffer: Buffer.from("<title>private</title>"), projectId: visible.id, visibility: "private" });
  const data = (await app.inject(`/public/api/pages?projectId=${visible.id}`)).json();
  assert.deepEqual(data.pages.map(page => page.slug), [pub.slug]);
  assert.deepEqual(data.projects, [{ id: visible.id, name: visible.name, documentCount: 1 }]);
  assert.equal(data.pages[0].projectName, visible.name);
  for (const id of [hidden.id, empty.id]) {
    const response = await app.inject(`/public/api/pages?projectId=${id}`);
    assert.equal(response.json().pages.length, 0);
    assert.doesNotMatch(response.body, /内部项目名称|空项目名称/);
  }
});

test("deleting a project unassigns active and trashed documents without changing content, links or permissions", async t => {
  const { store, call } = await setup(t);
  const project = store.saveProject(null, "可删除项目");
  const active = await store.importBuffer({ fileName: "keep.html", buffer: Buffer.from("<title>保留</title>"), projectId: project.id, visibility: "private" });
  const trashed = await store.importBuffer({ fileName: "trash.html", buffer: Buffer.from("<title>回收站</title>"), projectId: project.id });
  await store.deletePage(trashed.id);
  const before = await store.readPageHtml(active);
  assert.equal((await call("DELETE", `/projects/${project.id}`)).statusCode, 200);
  for (const page of [active, trashed]) assert.equal(store.getPage(page.id).projectId, "");
  assert.equal(store.getPage(active.id).visibility, "private");
  assert.equal(store.getPage(active.id).url, active.url);
  assert.equal(await store.readPageHtml(active), before);
  await store.restoreDeletedPage(trashed.id);
  assert.equal(store.getPage(trashed.id).projectId, "");
  assert.equal((await call("DELETE", `/projects/${project.id}`)).statusCode, 404);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});
