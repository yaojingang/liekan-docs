import { cookies } from "./document-access.js";
import { maxLogoBytes, readLogo, storeLogo } from "./brand.js";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultAdminPath, normalizeAdminPath } from "./admin-path.js";
import { injectEditBridge, autosaveDelayMs } from "./edit-bridge.js";
import { escapeHtml } from "./html.js";

function sendNotFound(reply, message = "Not found") {
  return reply.code(404).send({ error: message });
}

function publicPage(page) {
  return {
    ...page,
    canEdit: page.fileType === "html",
    canSync: page.fileType === "html" && page.visibility === "public" && page.homepageListed && !page.hasAccessPassword,
    canEditSource: page.sourceType === "watch",
  };
}

async function collectUploadParts(request) {
  const files = [];
  const relativePaths = [];
  for await (const part of request.parts()) {
    if (part.type === "field" && part.fieldname === "relativePath") {
      relativePaths.push(String(part.value || ""));
      continue;
    }
    if (part.type !== "file") continue;
    const buffer = await part.toBuffer();
    const relativePath = relativePaths.shift() || part.filename || "";
    files.push({
      fileName: path.basename(part.filename || relativePath || "file"),
      buffer,
      relativePath,
    });
  }
  return files;
}

const sessionCookieName = "tokdoc_session";
const legacySessionCookieName = "tokhtml_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 365 * 10;

async function syncPageToRemote(app, page) {
  if (page.visibility !== "public" || !page.homepageListed || page.hasAccessPassword) throw Object.assign(new Error("受限文档暂不支持上传线上，请保留本地访问保护"), {code: "DOCUMENT_SYNC_RESTRICTED"});
  if (page.fileType !== "html") {
    const error = new Error("只有 HTML 页面支持上传线上");
    error.code = "DOCUMENT_SYNC_UNSUPPORTED";
    throw error;
  }
  const settings = app.store.getRemoteSyncSettings(true);
  if (!settings.remoteSyncEnabled || !settings.remoteSyncUrl) {
    const error = new Error("请先在设置中绑定线上程序");
    error.code = "REMOTE_NOT_CONFIGURED";
    throw error;
  }
  let remoteUrl;
  try {
    remoteUrl = new URL(settings.remoteSyncUrl);
  } catch {
    const error = new Error("线上程序地址无效");
    error.code = "REMOTE_INVALID_URL";
    throw error;
  }
  if (!["http:", "https:"].includes(remoteUrl.protocol)) {
    const error = new Error("线上程序地址必须是 http 或 https");
    error.code = "REMOTE_INVALID_URL";
    throw error;
  }
  const html = await app.store.readPageHtml(page);
  const headers = {
    "content-type": "application/json",
    "user-agent": "tokdoc-sync",
  };
  if (settings.remoteSyncToken)
    headers.authorization = `Bearer ${settings.remoteSyncToken}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(remoteUrl, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        source: "tokdoc",
        legacySource: "tokhtml",
        syncedAt: new Date().toISOString(),
        page: {
          id: page.id,
          slug: page.slug,
          fileName: page.fileName,
          title: page.title,
          directoryName: page.directoryName,
          size: page.size,
          status: page.status,
          revision: page.revision,
          url: page.url,
          editUrl: page.editUrl,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        },
        html,
      }),
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function contentDisposition(fileName, disposition = "inline") {
  const fallback =
    String(fileName || "document.pdf")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document.pdf";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName || fallback)}`;
}

function parseCookies(header = "") { return cookies(header); }

function sessionCookie(token) {
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; SameSite=Lax`;
}

function expiredSessionCookie(name = sessionCookieName) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function normalizedPath(pathname) {
  if (pathname === "/") return "/";
  return String(pathname || "").replace(/\/+$/g, "") || "/";
}

function isActiveAdminPath(pathname, adminPath) {
  return normalizedPath(pathname) === adminPath;
}

function isActiveAdminSettingsPath(pathname, adminPath) {
  return normalizedPath(pathname) === `${adminPath}/settings`;
}

function isLegacyApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isScopedApiPath(pathname) {
  return /^\/[^/]+\/api(?:\/|$)/.test(pathname);
}

function isActiveAdminApiPath(pathname, adminPath) {
  return (
    pathname === `${adminPath}/api` || pathname.startsWith(`${adminPath}/api/`)
  );
}

function isPublicListPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/public/api/pages" ||
    /^\/type\/[^/]+\/?$/.test(pathname)
  );
}

function publicApiSuffix(pathname, adminPath) {
  const suffix = pathname.startsWith(`${adminPath}/api`)
    ? pathname.slice(adminPath.length)
    : pathname;
  return (
    suffix === "/api/health" ||
    suffix === "/api/session" ||
    suffix === "/api/login"
  );
}

function requestAccessState(app, request) {
  const url = new URL(request.url, "http://tokdoc.local");
  const pathname = url.pathname;
  const adminPath = app.store.getAdminPath();
  const usingDefaultAdminPath = adminPath === defaultAdminPath;
  const isPublicPageView =
    pathname.startsWith("/pages/") && url.searchParams.get("edit") !== "1";
  const isPublicShortPageView =
    /^\/[a-z0-9]{6}$/.test(pathname) && url.searchParams.get("edit") !== "1";
  if (
    pathname === "/healthz" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/page-assets/")
  )
    return "public";
  if (request.method === "POST" && /^\/public\/api\/documents\/[a-z0-9]{6}\/unlock$/.test(pathname)) return "public";
  if (pathname.startsWith("/document-assets/")) return "public";
  if (pathname.startsWith("/public/brand/")) return "public";
  if (isPublicListPath(pathname)) return "public";
  if (pathname === "/admin" || pathname === "/admin/")
    return usingDefaultAdminPath ? "public" : "not-found";
  if (pathname === "/admin/settings" || pathname === "/admin/settings/")
    return usingDefaultAdminPath ? "public" : "not-found";
  if (isActiveAdminPath(pathname, adminPath)) return "public";
  if (isActiveAdminSettingsPath(pathname, adminPath)) return "public";
  if (isLegacyApiPath(pathname)) {
    if (!usingDefaultAdminPath) return "not-found";
    return publicApiSuffix(pathname, adminPath) ? "public" : "protected";
  }
  if (isScopedApiPath(pathname)) {
    if (!isActiveAdminApiPath(pathname, adminPath)) return "not-found";
    return publicApiSuffix(pathname, adminPath) ? "public" : "protected";
  }
  if (isPublicShortPageView || isPublicPageView) return "public";
  return "protected";
}

async function sendGeneratedPage(app, request, reply, rawSlug) {
  const slug = String(rawSlug || "").replace(/\.html?$/i, "");
  if (!/^[a-z0-9]{6}$/.test(slug)) return sendNotFound(reply, "Page not found");
  const page = app.store.getActivePageBySlug(slug);
  if (!page) return sendNotFound(reply, "Page not found");
  const session = currentSession(app, request);
  if (page.visibility === "private" && !session)
    return sendNotFound(reply, "Page not found");
  reply.header("cache-control", "no-store");
  if (!page.homepageListed || page.hasAccessPassword || page.visibility === "private") reply.header("x-robots-tag", "noindex, noarchive, nofollow");
  if (!session && !app.store.access.allowed(page, request, reply)) {
    app.store.access.ensureDevice(request, reply);
    const template = await fs.readFile(path.join(app.config.publicDir, "locked.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(template
      .replaceAll("{{SLUG}}", page.slug)
      .replaceAll("{{HOME_LINK}}", app.store.getPublicSettings().publicHomepageEnabled ? '<a class="btn" href="/">返回文档首页</a>' : ""));
  }
  if (request.query?.edit === "1" && page.fileType !== "html") {
    return reply
      .code(400)
      .send({ error: "Document assets cannot be edited online" });
  }
  if (page.fileType !== "html") {
    const buffer = await app.store.readPageFile(page);
    if (request.method === "GET") app.store.incrementAccessCount(page.id);
    return reply
      .header("cache-control", "no-store")
      .header(
        "content-disposition",
        contentDisposition(`${page.slug}.pdf`),
      )
      .type(page.mimeType || "application/pdf")
      .send(buffer);
  }
  let html = await app.store.readPageHtml(page);
  if (page.hasAccessPassword && !session) html = html.replaceAll("/page-assets/", `/document-assets/${page.slug}/`);
  const output =
    request.query?.edit === "1"
      ? injectEditBridge(
          page,
          html,
          app.store.getAdminPath(),
          app.store.getSettings().adminName,
        )
      : html;
  if (request.method === "GET" && request.query?.edit !== "1") app.store.incrementAccessCount(page.id);
  return reply
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(output);
}

function currentSession(app, request) {
  const cookies = parseCookies(request.headers.cookie);
  for (const token of [
    cookies[sessionCookieName],
    cookies[legacySessionCookieName],
  ].filter(Boolean)) {
    const session = app.store.verifySessionToken(token);
    if (session) return session;
  }
  return null;
}

async function sendAdmin(app, reply) {
  return reply
    .type("text/html")
    .send(
      await fs.readFile(path.join(app.config.publicDir, "index.html"), "utf8"),
    );
}

function metaTag(name, content) {
  const value = String(content || "").trim();
  if (!value) return "";
  return `    <meta name="${name}" content="${escapeHtml(value)}" />\n`;
}

async function sendPublicIndex(app, reply) {
  if (!app.store.getSettings().publicHomepageEnabled)
    return sendNotFound(reply, "Public homepage disabled");
  const settings = app.store.getPublicSettings();
  const siteName = settings.siteName || "猎看文档系统";
  const seoTitle = settings.publicSeoTitle || siteName;
  const seoDescription = settings.publicSeoDescription || "";
  const seoKeywords = settings.publicSeoKeywords || "";
  let html = await fs.readFile(
    path.join(app.config.publicDir, "index-public.html"),
    "utf8",
  );
  html = html
    .replace(
      /<title>[\s\S]*?<\/title>/i,
      () => `<title>${escapeHtml(seoTitle)}</title>`,
    )
    .replace(/<meta name="description"[^>]*>\s*/gi, "")
    .replace(/<meta name="keywords"[^>]*>\s*/gi, "")
    .replace(
      "</head>",
      () =>
        `${metaTag("description", seoDescription)}${metaTag("keywords", seoKeywords)}  </head>`,
    )
    .replaceAll("{{SITE_NAME}}", () => escapeHtml(siteName))
    .replace("{{PUBLIC_BRAND_MARK}}", () => settings.publicLogoUrl
      ? `<span class="brand-mark has-image"><img class="brand-image" id="publicLogoImage" src="${escapeHtml(settings.publicLogoUrl)}" alt="" /><span class="brand-symbol" data-icon="document" hidden></span></span>`
      : '<span class="brand-mark"><span class="brand-symbol" data-icon="document" aria-hidden="true"></span></span>')
    .replace("{{PUBLIC_BRAND_CAPTION}}", () => settings.publicBrandCaption
      ? `<span class="brand-caption">${escapeHtml(settings.publicBrandCaption)}</span>` : "")
    .replaceAll("{{DESCRIPTION}}", () =>
      escapeHtml(seoDescription || "按类型筛选、搜索并打开公开文档。"),
    )
    .replace(/<!-- PUBLIC_NAVIGATION -->[\s\S]*?<!-- \/PUBLIC_NAVIGATION -->/, () =>
      settings.publicNavigation.map(item => `<a class="public-menu-link"${item.id === "all-documents" ? ' id="allDocumentsLink"' : ""} data-nav-id="${escapeHtml(item.id)}" href="${escapeHtml(item.url)}"${item.newTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(item.label)}</a>`).join("\n"),
    );
  return reply.type("text/html").send(html);
}

function normalizedPublicType(value) {
  const type = String(value || "all")
    .trim()
    .toLowerCase();
  return ["html", "pdf", "word"].includes(type) ? type : "all";
}

function registerApiRoutes(app, prefix = "") {
  app.post(`${prefix}/api/brand/logo`, async (request, reply) => {
    try {
      let bytes;
      for await (const part of request.parts({ limits: { fileSize: maxLogoBytes, files: 1, fields: 0 } })) bytes = await part.toBuffer();
      if (!bytes) return reply.code(400).send({ error: "请选择 LOGO 图片" });
      return { url: await storeLogo(app.config, bytes) };
    } catch (error) {
      if (error.code === "BRAND_INVALID") return reply.code(error.statusCode || 400).send({ error: error.message, field: "publicLogoUrlInput" });
      if (error.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "LOGO 图片最大为 2 MiB" });
      if (["FST_FILES_LIMIT", "FST_FIELDS_LIMIT", "FST_INVALID_MULTIPART_CONTENT_TYPE"].includes(error.code)) return reply.code(400).send({ error: "每次请选择一张 LOGO 图片" });
      throw error;
    }
  });
  app.get(`${prefix}/api/health`, async () => ({
    ok: true,
    name: "liekan-docs",
    time: new Date().toISOString(),
  }));

  app.get(`${prefix}/api/session`, async (request) => {
    const session = currentSession(app, request);
    const publicSettings = app.store.getPublicSettings();
    if (!session) return { authenticated: false, publicSettings };
    return { authenticated: true, username: session.username, publicSettings };
  });

  app.post(`${prefix}/api/login`, async (request, reply) => {
    const body = request.body || {};
    if (!app.store.verifyCredentials(body.username, body.password)) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    const token = app.store.createSessionToken(String(body.username || ""));
    return reply
      .header("set-cookie", sessionCookie(token))
      .send({ authenticated: true, username: body.username });
  });

  app.post(`${prefix}/api/logout`, async (request, reply) => {
    return reply
      .header("set-cookie", [
        expiredSessionCookie(),
        expiredSessionCookie(legacySessionCookieName),
      ])
      .send({ authenticated: false });
  });

  app.get(`${prefix}/api/pages`, async (request) => {
    const result = app.store.listPagesPage(request.query || {});
    return {
      pages: result.pages.map(publicPage),
      pagination: result.pagination,
      ...app.store.managementSummary(request.query || {}),
    };
  });

  app.get(`${prefix}/api/analytics`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { ...app.store.analytics.report(request.query || {}), documentStats: app.store.managementSummary().stats };
  });

  app.get(`${prefix}/api/analytics/rankings`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { ...app.store.analytics.rankingDetails(request.query || {}), documentStats: app.store.managementSummary().stats };
  });

  app.get(`${prefix}/api/pages/:id`, async (request, reply) => {
    const page = app.store.getPage(request.params.id);
    if (!page) return sendNotFound(reply, "Page not found");
    const html =
      page.fileType === "html" ? await app.store.readPageHtml(page) : "";
    return { page: publicPage(page), html };
  });

  app.get(`${prefix}/api/pages/:id/download`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const page = app.store.getPage(request.params.id);
    if (!page || page.deletedAt) return sendNotFound(reply, "文档不存在或已移入回收站");
    try {
      const filePath = page.sourcePath || (page.fileType !== "word" && await app.store.resolveGeneratedPath(page));
      if (!filePath) return sendNotFound(reply, "源文件不存在，暂时无法下载");
      const buffer = await fs.readFile(filePath);
      return reply
        .header("content-disposition", contentDisposition(page.fileName, "attachment"))
        .header("x-content-type-options", "nosniff")
        .type("application/octet-stream")
        .send(buffer);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code))
        return sendNotFound(reply, "源文件不存在或无法读取，暂时无法下载");
      throw error;
    }
  });

  app.post(`${prefix}/api/pages/upload`, async (request, reply) => {
    const files = await collectUploadParts(request);
    let created;
    try {
      created = await app.store.importUploadFiles(files);
    } catch (error) {
      if (error.code === "WORD_CONVERSION_FAILED")
        return reply.code(422).send({ error: error.message });
      throw error;
    }
    if (!created.length)
      return reply.code(400).send({ error: "No supported files uploaded" });
    return reply.code(201).send({ pages: created.map(publicPage) });
  });

  app.post(`${prefix}/api/pages/upload/prepare`, async (request, reply) => {
    const files = await collectUploadParts(request);
    const staged = await app.store.stageUploadFiles(files);
    if (!staged.documents.length)
      return reply.code(400).send({ error: "No supported files uploaded" });
    return reply.code(201).send(staged);
  });

  app.post(
    `${prefix}/api/pages/upload/:uploadId/confirm`,
    async (request, reply) => {
      let created;
      try {
        created = await app.store.confirmStagedUpload(
          request.params.uploadId,
          request.body || {},
        );
      } catch (error) {
        if (error.code === "DOCUMENT_ACCESS") return reply.code(error.statusCode).send({ error: error.message });
        if (error.message === "Upload batch not found")
          return reply.code(404).send({ error: error.message });
        if (error.code === "WORD_CONVERSION_FAILED")
          return reply.code(422).send({ error: error.message });
        throw error;
      }
      if (!created.length)
        return reply.code(400).send({ error: "No supported files uploaded" });
      return reply.code(201).send({ pages: created.map(publicPage) });
    },
  );

  app.delete(`${prefix}/api/pages/upload/:uploadId`, async (request, reply) => {
    try {
      await app.store.cancelStagedUpload(request.params.uploadId);
    } catch {
      return reply.code(404).send({ error: "Upload batch not found" });
    }
    return reply.code(204).send();
  });

  app.get(`${prefix}/api/settings`, async () => ({
    settings: app.store.getSettings(),
    runtime: {
      generatedDir: app.config.generatedDir,
      watchMode: "events",
      autosaveDelayMs,
      snapshotsEnabled: true,
      configuredSourceWriteDefault: Boolean(app.config.allowSourceWrite),
    },
  }));

  app.patch(`${prefix}/api/settings`, { schema: { body: {
    type: "object",
    properties: {
      publicLogoUrl: { type: "string", maxLength: 2048 },
      publicBrandCaption: { type: "string", maxLength: 80 },
      publicNavigation: {
      type: "array", minItems: 1, maxItems: 10,
      items: {
        type: "object", required: ["id", "label", "url", "newTab", "enabled"],
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
          label: { type: "string", minLength: 1, maxLength: 20 },
          url: { type: "string", minLength: 1, maxLength: 2048 },
          newTab: { type: "boolean" }, enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
    } },
  } } }, async (request, reply) => {
    const body = request.body || {};
    if (Object.hasOwn(body, "adminPath")) {
      let nextAdminPath;
      try {
        nextAdminPath = normalizeAdminPath(body.adminPath || defaultAdminPath);
      } catch (error) {
        return reply.code(400).send({ error: error.message });
      }
      if (
        nextAdminPath !== app.store.getAdminPath() &&
        !app.store.verifyCredentials(
          request.auth?.username,
          body.currentPassword || "",
        )
      ) {
        return reply
          .code(400)
          .send({ error: "修改后台访问目录需要输入当前密码" });
      }
    }
    let settings;
    try {
      settings = await app.store.saveSettings(body);
    } catch (error) {
      if (["NAVIGATION_INVALID", "BRAND_INVALID"].includes(error.code))
        return reply.code(400).send({ error: error.message, field: error.field });
      if (String(error.code || "").startsWith("ADMIN_PATH_"))
        return reply.code(400).send({ error: error.message });
      throw error;
    }
    if (
      Object.hasOwn(body, "authUsername") ||
      Object.hasOwn(body, "authPassword")
    ) {
      reply.header(
        "set-cookie",
        sessionCookie(app.store.createSessionToken(settings.authUsername)),
      );
    }
    return { settings };
  });

  app.post(`${prefix}/api/pages/samples`, async (request, reply) => {
    const pages = await app.store.addSamplePages();
    return reply.code(201).send({ pages: pages.map(publicPage) });
  });

  app.patch(`${prefix}/api/pages/:id/access`, async (request, reply) => {
    try {
      const page = await app.store.access.update(request.params.id, request.body || {});
      return page ? { page: publicPage(page) } : sendNotFound(reply, "Page not found");
    } catch (error) { if (error.code === "DOCUMENT_ACCESS") return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  });
  app.post(`${prefix}/api/pages/:id/access/revoke`, async (request, reply) => {
    const page = app.store.getPage(request.params.id);
    if (!page || page.deletedAt) return sendNotFound(reply, "Page not found");
    app.store.access.revoke(page.id);
    return { ok: true };
  });

  app.patch(`${prefix}/api/pages/:id`, async (request, reply) => {
    const body = request.body || {};
    if (!Object.hasOwn(body, "visibility"))
      return reply.code(400).send({ error: "visibility is required" });
    const page = await app.store.updatePageVisibility(
      request.params.id,
      body.visibility,
    );
    if (!page) return sendNotFound(reply, "Page not found");
    return { page: publicPage(page) };
  });

  app.patch(`${prefix}/api/pages/:id/content`, async (request, reply) => {
    try {
      const page = await app.store.savePageContent(
        request.params.id,
        request.body || {},
      );
      return { page: publicPage(page) };
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") {
        return reply
          .code(409)
          .send({ error: "Revision conflict", page: publicPage(error.page) });
      }
      if (error.code === "DOCUMENT_NOT_EDITABLE")
        return reply.code(400).send({ error: error.message });
      if (error.code === "DOCUMENT_ACCESS") return reply.code(error.statusCode).send({error:error.message});
      if (error.code === "NOT_FOUND") return sendNotFound(reply, error.message);
      throw error;
    }
  });

  app.delete(`${prefix}/api/pages/:id`, async (request, reply) => {
    const page = await app.store.deletePage(request.params.id);
    if (!page) return sendNotFound(reply, "Page not found");
    return { page: publicPage(page) };
  });

  app.post(`${prefix}/api/pages/:id/sync`, async (request, reply) => {
    try {
      const page = app.store.getPage(request.params.id);
      if (!page) return sendNotFound(reply, "Page not found");
      if (page.deletedAt)
        return reply
          .code(400)
          .send({ error: "回收站页面需要恢复后才能上传线上" });
      if (page.fileType !== "html")
        return reply.code(400).send({ error: "只有 HTML 页面支持上传线上" });
      const sync = await syncPageToRemote(app, page);
      if (!sync.ok)
        return reply.code(502).send({ error: "线上程序返回失败", sync });
      return { sync };
    } catch (error) {
      if (
        error.code === "DOCUMENT_SYNC_RESTRICTED" ||
        error.code === "REMOTE_NOT_CONFIGURED" ||
        error.code === "REMOTE_INVALID_URL"
      ) {
        return reply.code(400).send({ error: error.message });
      }
      if (error.name === "AbortError")
        return reply.code(504).send({ error: "线上上传超时" });
      throw error;
    }
  });

  app.post(`${prefix}/api/pages/:id/restore`, async (request, reply) => {
    try {
      const page = await app.store.restoreDeletedPage(request.params.id);
      if (!page) return sendNotFound(reply, "Page not found");
      return { page: publicPage(page) };
    } catch (error) {
      if (error.code === "DOCUMENT_ACCESS") return reply.code(error.statusCode).send({error:error.message});
      if (error.code === "NOT_FOUND") return sendNotFound(reply, error.message);
      throw error;
    }
  });

  app.get(`${prefix}/api/pages/:id/versions`, async (request, reply) => {
    const page = app.store.getPage(request.params.id);
    if (!page) return sendNotFound(reply, "Page not found");
    return { versions: app.store.listVersions(page.id) };
  });

  app.post(
    `${prefix}/api/pages/:id/restore/:versionId`,
    async (request, reply) => {
      try {
        const page = await app.store.restoreVersion(
          request.params.id,
          request.params.versionId,
        );
        return { page: publicPage(page) };
      } catch (error) {
        if (error.code === "NOT_FOUND")
          return sendNotFound(reply, error.message);
        throw error;
      }
    },
  );

  app.get(`${prefix}/api/watch-dirs`, async () => ({
    watchDirs: app.store.listWatchDirs(),
  }));

  app.post(`${prefix}/api/watch-dirs`, async (request, reply) => {
    const body = request.body || {};
    if (!body.path) return reply.code(400).send({ error: "path is required" });
    const watchDir = await app.store.addWatchDir({
      path: body.path,
      name: body.name,
      allowWrite: Boolean(body.allowWrite),
      createIfMissing: true,
    });
    await app.watchService.refresh();
    const scanned = await app.store.rescanWatchDir(watchDir.id);
    return reply.code(201).send({ watchDir: scanned });
  });

  app.delete(`${prefix}/api/watch-dirs/:id`, async (request, reply) => {
    const watchDir = await app.store.removeWatchDir(request.params.id);
    if (!watchDir) return sendNotFound(reply, "Watch directory not found");
    await app.watchService.refresh();
    return { watchDir };
  });

  app.post(`${prefix}/api/watch-dirs/:id/rescan`, async (request, reply) => {
    try {
      const watchDir = await app.store.rescanWatchDir(request.params.id);
      return { watchDir };
    } catch {
      return sendNotFound(reply, "Watch directory not found");
    }
  });
}

export function registerRoutes(app) {
  app.setNotFoundHandler((request, reply) => sendNotFound(reply));
  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = new URL(request.url, "http://tokdoc.local").pathname;
    const isResource =
      /^\/(?:assets|page-assets|document-assets)(?:\/|$)/.test(pathname) ||
      pathname === "/healthz" ||
      pathname === "/favicon.ico";
    const isApi = /^\/(?:[^/]+\/)?api(?:\/|$)/.test(pathname);
    if (
      reply.statusCode < 400 ||
      !["GET", "HEAD"].includes(request.method) ||
      !request.headers.accept?.includes("text/html") ||
      isResource ||
      isApi
    )
      return payload;
    const code = reply.statusCode;
    const titles = {
      400: "此操作暂不可用",
      401: "请先登录",
      404: "页面暂不可访问",
    };
    const notes = {
      400: "该文档类型不支持此操作，请返回阅读页面。",
      401: "当前操作需要有效的管理登录状态。",
      404: "链接可能已失效，或当前没有访问此页面的权限。",
    };
    const settings = app.store.getPublicSettings();
    let actions = settings.publicHomepageEnabled
      ? '<a class="btn primary" href="/">返回文档首页</a>'
      : "";
    if (
      currentSession(app, request) &&
      (pathname.startsWith(app.store.getAdminPath()) ||
        request.query?.edit === "1")
    ) {
      actions += `<a class="btn" href="${escapeHtml(app.store.getAdminPath())}">返回管理器</a>`;
    }
    const template = await fs.readFile(
      path.join(app.config.publicDir, "error.html"),
      "utf8",
    );
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store");
    return template
      .replaceAll("{{SITE_NAME}}", () =>
        escapeHtml(settings.siteName || "猎看文档系统"),
      )
      .replaceAll("{{STATUS}}", String(code))
      .replaceAll("{{TITLE}}", titles[code] || "服务暂时不可用")
      .replaceAll(
        "{{MESSAGE}}",
        notes[code] || "请稍后重试，当前内容不会因此被修改。",
      )
      .replaceAll("{{ACTIONS}}", actions);
  });
  app.addHook("preHandler", async (request, reply) => {
    const access = requestAccessState(app, request);
    if (access === "not-found") return sendNotFound(reply, "Not found");
    if (access === "public") return;
    const session = currentSession(app, request);
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    request.auth = session;
  });

  app.get("/", async (request, reply) => sendPublicIndex(app, reply));
  app.get("/public/brand/:fileName", async (request, reply) => {
    try {
      const logo = await readLogo(app.config, request.params.fileName);
      if (!logo) return sendNotFound(reply);
      return reply.type(logo.type).header("x-content-type-options", "nosniff").header("cache-control", "public, max-age=31536000, immutable").send(logo.bytes);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "LOGO 暂不可用" });
    }
  });
  app.get("/healthz", async () => ({
    ok: true,
    name: "liekan-docs",
    time: new Date().toISOString(),
  }));
  app.get("/type/:fileType", async (request, reply) => {
    if (
      !["html", "pdf", "word"].includes(
        String(request.params.fileType || "").toLowerCase(),
      )
    ) {
      return sendNotFound(reply, "Type not found");
    }
    return sendPublicIndex(app, reply);
  });
  app.post("/public/api/documents/:slug/unlock", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const page = app.store.getActivePageBySlug(request.params.slug);
    if (!page || page.visibility === "private") return sendNotFound(reply, "Page not found");
    try { return await app.store.access.unlock(page,request,reply); }
    catch (error) {
      if (error.code !== "DOCUMENT_ACCESS") throw error;
      if (error.retryAfter) reply.header("retry-after",error.retryAfter);
      return reply.code(error.statusCode).send({ error: error.message });
    }
  });
  app.get("/public/api/pages", async (request, reply) => {
    if (!app.store.getSettings().publicHomepageEnabled)
      return sendNotFound(reply, "Public homepage disabled");
    const result = app.store.listPublicPagesPage({
      ...request.query,
      type: normalizedPublicType(request.query?.type),
    });
    return result;
  });
  app.get("/admin", async (request, reply) => sendAdmin(app, reply));
  app.get("/admin/", async (request, reply) => sendAdmin(app, reply));
  app.get("/admin/settings", async (request, reply) => sendAdmin(app, reply));
  app.get("/admin/settings/", async (request, reply) => sendAdmin(app, reply));
  app.get("/favicon.ico", async (request, reply) => reply.code(204).send());

  registerApiRoutes(app);
  registerApiRoutes(app, "/:adminPath");

  app.get("/pages/:slug", async (request, reply) => {
    return sendGeneratedPage(app, request, reply, request.params.slug);
  });

  app.get("/:slug/", async (request, reply) => {
    if (isActiveAdminPath(`/${request.params.slug}`, app.store.getAdminPath()))
      return sendAdmin(app, reply);
    return sendNotFound(reply, "Page not found");
  });

  app.get("/:slug/settings", async (request, reply) => {
    if (isActiveAdminPath(`/${request.params.slug}`, app.store.getAdminPath()))
      return sendAdmin(app, reply);
    return sendNotFound(reply, "Page not found");
  });

  app.get("/:slug/settings/", async (request, reply) => {
    if (isActiveAdminPath(`/${request.params.slug}`, app.store.getAdminPath()))
      return sendAdmin(app, reply);
    return sendNotFound(reply, "Page not found");
  });

  app.get("/:slug", async (request, reply) => {
    if (isActiveAdminPath(`/${request.params.slug}`, app.store.getAdminPath()))
      return sendAdmin(app, reply);
    return sendGeneratedPage(app, request, reply, request.params.slug);
  });
}
