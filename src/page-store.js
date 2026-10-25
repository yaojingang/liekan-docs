import { DocumentAccess } from "./document-access.js";
import { PageAnalytics } from "./analytics.js";
import { defaultBrandCaption, isPublicUrl, validateBrandSettings } from "./brand.js";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  basenameWithoutExtension,
  checksum,
  buildManagedSlug,
  composeDocument,
  documentTitleFromFileName,
  generatedMimeType,
  injectAssetBase,
  injectTrackingCode,
  isHtmlFile,
  isManagedFile,
  managedFileType,
  parentDirectoryNameFromPath,
  parentDirectoryNameFromRelative,
  parseHtmlMetadata,
  removeEditBridge,
  slugify,
} from "./html.js";
import {
  defaultAdminPath,
  normalizeAdminPath,
  safeAdminPath,
} from "./admin-path.js";

const execFileAsync = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

function displayTime(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function dateStamp(iso) {
  const value = new Date(iso || Date.now());
  const year = String(value.getFullYear());
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function displayDate(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso)).replaceAll("/", "-");
}

function generatedFileNameForPage(page) {
  return generatedFileNameForAsset(page, "html");
}

function generatedExtensionForPage(page) {
  return page.fileType === "html" ? "html" : "pdf";
}

function generatedFileNameForAsset(page, extension = "html") {
  const originalName = basenameWithoutExtension(page.fileName || "page");
  const cleanName = slugify(originalName).slice(0, 96) || "page";
  return `${dateStamp(page.createdAt)}-${cleanName}-${page.slug}.${extension.replace(/^\./, "")}`;
}

function normalizeVisibility(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "private"
    ? "private"
    : "public";
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function cleanAssetRelativePath(value = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function rowToPage(row) {
  if (!row) return null;
  const fileType = row.file_type || "html";
  return {
    id: row.id,
    slug: row.slug,
    fileName: row.file_name,
    title: row.title,
    fileType,
    mimeType: row.mime_type || generatedMimeType(fileType),
    sourceType: row.source_type,
    sourcePath: row.source_path,
    directoryName: row.directory_name || "",
    size: row.size,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    uploadTime: displayTime(row.created_at),
    updatedTime: displayTime(row.updated_at),
    revision: row.revision,
    generatedPath: row.generated_path,
    rawMtimeMs: row.raw_mtime_ms,
    checksum: row.checksum,
    edited: Boolean(row.edited),
    accessCount: row.access_count || 0,
    visibility: normalizeVisibility(row.visibility),
    homepageListed: Boolean(row.homepage_listed ?? 1),
    hasAccessPassword: Boolean(row.access_password_hash),
    deletedAt: row.deleted_at || "",
    deletedTime: row.deleted_at ? displayTime(row.deleted_at) : "",
    deletedPath: row.deleted_path || "",
    url: `/${row.slug}`,
    editUrl: fileType === "html" ? `/${row.slug}?edit=1` : "",
  };
}

function rowToWatchDir(row) {
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    source: row.name,
    allowWrite: Boolean(row.allow_write),
    status: row.status,
    htmlCount: row.html_count,
    lastScanAt: row.last_scan_at,
    lastScan: row.last_scan_at ? displayTime(row.last_scan_at) : "等待扫描",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isPublicListablePage(page) {
  return Boolean(
    page &&
      page.visibility !== "private" &&
      page.homepageListed &&
      !page.deletedAt &&
      ["published", "edited"].includes(page.status),
  );
}

function publicPageSummary(page) {
  return {
    slug: page.slug,
    hasAccessPassword: page.hasAccessPassword,
    title: page.title,
    fileName: page.fileName,
    fileType: page.fileType,
    directoryName: page.directoryName || "",
    size: page.size,
    uploadTime: page.uploadTime,
    updatedTime: page.updatedTime,
    updatedDate: displayDate(page.updatedAt),
    url: page.url,
  };
}

function cleanUploadPath(value, fallback = "file") {
  const source = String(value || fallback || "file").replace(/\\/g, "/");
  const parts = source
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[\u0000-\u001f<>:"|?*]/g, "_"));
  if (parts.length) return parts.join("/");
  return (
    path.basename(fallback || "file").replace(/[\u0000-\u001f<>:"|?*]/g, "_") ||
    "file"
  );
}

function editableUploadFileName(value, fallback = "file") {
  const fallbackName = path.posix.basename(cleanUploadPath(fallback, "file"));
  const fallbackExtension = path.posix.extname(fallbackName);
  const rawName = path.posix
    .basename(String(value || "").replace(/\\/g, "/"))
    .trim();
  const cleaned =
    cleanUploadPath(rawName || fallbackName, fallbackName)
      .split("/")
      .at(-1) || fallbackName;
  const currentExtension = path.posix.extname(cleaned);
  const currentStem = currentExtension
    ? cleaned.slice(0, -currentExtension.length)
    : cleaned;
  const fallbackStem = fallbackExtension
    ? fallbackName.slice(0, -fallbackExtension.length)
    : fallbackName;
  const stem = (currentStem || fallbackStem || "file").trim();
  return `${stem}${fallbackExtension || currentExtension}`;
}

function replaceRelativeBasename(relativePath, fileName) {
  const directory = path.posix.dirname(relativePath);
  if (!directory || directory === ".") return fileName;
  return `${directory}/${fileName}`;
}

function assetBaseUrl(uploadRootId, relativePath) {
  const directory = path.posix.dirname(relativePath);
  const segments = [uploadRootId];
  if (directory && directory !== ".")
    segments.push(...directory.split("/").filter(Boolean));
  return `/page-assets/${segments.map((segment) => encodeURIComponent(segment)).join("/")}/`;
}

function safeDestination(root, relativePath) {
  const destination = path.join(root, ...relativePath.split("/"));
  const resolvedRoot = path.resolve(root);
  const resolvedDestination = path.resolve(destination);
  if (
    resolvedDestination !== resolvedRoot &&
    !resolvedDestination.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("Invalid upload path");
  }
  return resolvedDestination;
}

const defaultAuthUsername = "admin";
const defaultAuthPassword = "tokdoc";
const defaultSiteName = "猎看文档系统";
const defaultAdminName = "猎看文档系统";
const defaultPublicSeoDescription =
  "公开文档索引，集中阅读 HTML、PDF 与 Word 文档。";
const defaultPublicSeoKeywords = "猎看文档系统,文档索引,HTML,PDF,Word";

function defaultPublicNavigation() {
  return [{ id: "all-documents", label: "全部文档", url: "/?view=resources", newTab: false, enabled: true }];
}

function validatePublicNavigation(value) {
  const fail = (message, field = "navigationSettings") => {
    throw Object.assign(new Error(message), { code: "NAVIGATION_INVALID", field });
  };
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    fail("前台菜单需要保留全部文档，最多设置 10 项");
  const ids = new Set();
  const result = value.map(item => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id))
      fail("前台菜单标识无效或重复");
    ids.add(item.id);
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!label || [...label].length > 20)
      fail("菜单名称需填写 1 至 20 个字符", `navigationLabel-${item.id}`);
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!isPublicUrl(url))
      fail("菜单链接需填写站内路径或 HTTP/HTTPS 地址", `navigationUrl-${item.id}`);
    if (typeof item.newTab !== "boolean" || typeof item.enabled !== "boolean")
      fail("菜单打开方式和显示状态无效");
    if (item.id === "all-documents" && (label !== "全部文档" || url !== "/?view=resources" || !item.enabled || item.newTab))
      fail("全部文档为内置菜单，请保留默认名称、地址和显示状态");
    return { id: item.id, label, url, newTab: item.newTab, enabled: item.enabled };
  });
  if (!ids.has("all-documents")) fail("请保留全部文档菜单");
  return result;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto
    .scryptSync(String(password), salt, 32)
    .toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encodedHash) {
  const [, salt, hash] = String(encodedHash || "").split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function signSessionPayload(payload, authSettings) {
  return crypto
    .createHmac(
      "sha256",
      `${authSettings.authSecret}:${authSettings.authPasswordHash}`,
    )
    .update(payload)
    .digest("base64url");
}

export class PageStore {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.access = new DocumentAccess(this);
    this.analytics = new PageAnalytics(db);
    this.writingPages = new Set();
  }

  async ensureStorage() {
    await Promise.all([
      fs.mkdir(this.config.uploadsDir, { recursive: true }),
      fs.mkdir(this.pendingUploadDir(), { recursive: true }),
      fs.mkdir(this.config.generatedDir, { recursive: true }),
      fs.mkdir(this.trashDir(), { recursive: true }),
      fs.mkdir(this.config.versionsDir, { recursive: true }),
    ]);
  }

  trashDir() {
    return this.config.trashDir || path.join(this.config.dataDir, "trash");
  }

  async seedConfiguredWatchDirs() {
    for (const watchPath of this.config.watchDirs) {
      await this.addWatchDir({
        path: watchPath,
        name: path.basename(watchPath),
        allowWrite: this.config.allowSourceWrite,
        createIfMissing: true,
      });
    }
  }

  listPages(filters = {}) {
    const rows = this.db
      .prepare("SELECT * FROM pages ORDER BY updated_at DESC")
      .all();
    const q = String(filters.q || "")
      .trim()
      .toLowerCase();
    const status = String(filters.status || "all");
    const directory = String(filters.directory || "");
    const requestedType = String(filters.type || filters.fileType || "all")
      .trim()
      .toLowerCase();
    const visibilityInput = String(filters.visibility || "all")
      .trim()
      .toLowerCase();
    const requestedVisibility = ["public", "private"].includes(visibilityInput)
      ? visibilityInput
      : "all";
    const sort = String(filters.sort || "updated_desc");
    const scope = String(filters.scope || "active");
    const wantsTrash = scope === "trash" || status === "trashed";
    const pages = rows.map(rowToPage).filter((page) => {
      if (wantsTrash && !page.deletedAt) return false;
      if (!wantsTrash && page.deletedAt) return false;
      const matchesType =
        requestedType === "all" ||
        !requestedType ||
        (requestedType === "other" ? !["html", "pdf", "word"].includes(page.fileType) : page.fileType === requestedType);
      const matchesStatus =
        wantsTrash ||
        status === "all" ||
        !status ||
        (status === "published" && page.status === "published") ||
        (status === "edited" && page.edited);
      const matchesVisibility =
        requestedVisibility === "all" ||
        page.visibility === requestedVisibility;
      const matchesDirectory =
        String(filters.directoryEmpty || "") === "1"
          ? !page.directoryName
          : !directory || page.directoryName === directory;
      const haystack =
        `${page.id} ${page.slug} ${page.fileName} ${page.title} ${page.directoryName} ${page.url}`.toLowerCase();
      return (
        matchesType &&
        matchesStatus &&
        matchesVisibility &&
        (!filters.accessMode || filters.accessMode === "all" || (filters.accessMode === "private" ? page.visibility === "private" : page.visibility === "public" && page.homepageListed === (filters.accessMode === "listed"))) &&
        (!filters.password || filters.password === "all" || page.hasAccessPassword === (filters.password === "yes")) &&
        matchesDirectory &&
        (!q || haystack.includes(q))
      );
    });
    if (sort === "created_desc") {
      return pages.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }
    if (sort === "access_desc") {
      return pages.sort(
        (a, b) =>
          b.accessCount - a.accessCount ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }
    return pages.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  listPagesPage(filters = {}) {
    const allPages = this.listPages(filters);
    const requestedPageSize = Number(filters.pageSize || 20);
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(Math.max(Math.trunc(requestedPageSize), 1), 100)
      : 20;
    const total = allPages.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = Number(filters.page || 1);
    const page = Number.isFinite(requestedPage)
      ? Math.min(Math.max(Math.trunc(requestedPage), 1), totalPages)
      : 1;
    const offset = (page - 1) * pageSize;
    return {
      pages: allPages.slice(offset, offset + pageSize),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        offset,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
    };
  }

  managementSummary(filters = {}) {
    const suppliedStart = filters.dayStart;
    const suppliedEnd = filters.dayEnd;
    let start;
    let end;
    if (suppliedStart !== undefined || suppliedEnd !== undefined) {
      const validIso = (value) => {
        if (typeof value !== "string") return false;
        const match = value.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
        );
        if (!match || !Number.isFinite(Date.parse(value))) return false;
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const calendar = new Date(Date.UTC(year, month - 1, day));
        return (
          calendar.getUTCFullYear() === year &&
          calendar.getUTCMonth() === month - 1 &&
          calendar.getUTCDate() === day &&
          hour < 24 &&
          minute < 60 &&
          second < 60
        );
      };
      if (
        !validIso(suppliedStart) ||
        !validIso(suppliedEnd) ||
        Date.parse(suppliedEnd) <= Date.parse(suppliedStart) ||
        Date.parse(suppliedEnd) - Date.parse(suppliedStart) > 26 * 3600000
      ) {
        throw Object.assign(
          new Error(
            "日期范围须为成对的有效 ISO 时间，起点早于终点，且不超过 26 小时",
          ),
          { statusCode: 400 },
        );
      }
      start = new Date(suppliedStart).toISOString();
      end = new Date(suppliedEnd).toISOString();
    } else {
      const now = new Date();
      start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      ).toISOString();
      end = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      ).toISOString();
    }
    const totals = this.db
      .prepare(
        `SELECT
      COALESCE(SUM(deleted_at IS NULL), 0) AS all_count,
      COALESCE(SUM(deleted_at IS NULL AND COALESCE(NULLIF(file_type, ''), 'html') = 'html'), 0) AS html_count,
      COALESCE(SUM(deleted_at IS NULL AND file_type = 'pdf'), 0) AS pdf_count,
      COALESCE(SUM(deleted_at IS NULL AND file_type = 'word'), 0) AS word_count,
      COALESCE(SUM(deleted_at IS NULL AND created_at >= ? AND created_at < ?), 0) AS today_count,
      COALESCE(SUM(deleted_at IS NOT NULL), 0) AS trash_count FROM pages`,
      )
      .get(start, end);
    const trash = filters.scope === "trash" || filters.status === "trashed";
    const directories = this.db
      .prepare(
        `SELECT COALESCE(directory_name, '') AS name, COUNT(*) AS count FROM pages
      WHERE deleted_at IS ${trash ? "NOT " : ""}NULL GROUP BY COALESCE(directory_name, '') ORDER BY name`,
      )
      .all()
      .map((row) => ({ name: row.name, count: row.count }));
    return {
      stats: {
        ...this.analytics.summary(start, end),
        all: totals.all_count,
        editable: totals.html_count,
        todayCreated: totals.today_count,
        trash: totals.trash_count,
        watchDirs: this.db
          .prepare("SELECT COUNT(*) AS count FROM watch_dirs")
          .get().count,
        byType: {
          html: totals.html_count,
          pdf: totals.pdf_count,
          word: totals.word_count,
          other: totals.all_count - totals.html_count - totals.pdf_count - totals.word_count,
        },
      },
      facets: { directories },
    };
  }

  publicPageStats() {
    const stats = { all: 0, html: 0, pdf: 0, word: 0 };
    for (const page of this.listPages({
      scope: "active",
      status: "all",
    }).filter(isPublicListablePage)) {
      stats.all += 1;
      if (Object.hasOwn(stats, page.fileType)) stats[page.fileType] += 1;
    }
    return stats;
  }

  listPublicPagesPage(filters = {}) {
    const type = String(filters.type || filters.fileType || "all")
      .trim()
      .toLowerCase();
    const normalizedType = ["html", "pdf", "word"].includes(type)
      ? type
      : "all";
    const requestedSort = String(filters.sort || "updated_desc").trim();
    const publicSort = ["updated_desc", "created_desc"].includes(requestedSort)
      ? requestedSort
      : "updated_desc";
    const allFilteredPages = this.listPages({
      ...filters,
      sort: publicSort,
      scope: "active",
      status: "all",
      type: normalizedType,
    }).filter(isPublicListablePage);
    const requestedPageSize = Number(filters.pageSize || 10);
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(Math.max(Math.trunc(requestedPageSize), 1), 100)
      : 10;
    const total = allFilteredPages.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = Number(filters.page || 1);
    const page = Number.isFinite(requestedPage)
      ? Math.min(Math.max(Math.trunc(requestedPage), 1), totalPages)
      : 1;
    const offset = (page - 1) * pageSize;
    return {
      pages: allFilteredPages
        .slice(offset, offset + pageSize)
        .map(publicPageSummary),
      stats: this.publicPageStats(),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        offset,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
    };
  }

  getPage(id) {
    return rowToPage(
      this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id),
    );
  }

  getPageBySlug(slug) {
    return rowToPage(
      this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug),
    );
  }

  getActivePageBySlug(slug) {
    return rowToPage(
      this.db
        .prepare("SELECT * FROM pages WHERE slug = ? AND deleted_at IS NULL")
        .get(slug),
    );
  }

  updatePageVisibility(id, visibility) {
    return this.access.update(id, { visibility: normalizeVisibility(visibility) });
  }

  assetPathVisibility(uploadRootId, assetRelativePath = "") {
    const safeUploadRootId = String(uploadRootId || "");
    if (!/^[a-z0-9-]{20,80}$/i.test(safeUploadRootId)) return "private";
    const safeRelativePath = cleanAssetRelativePath(assetRelativePath);
    if (!safeRelativePath) return "private";
    const root = path.resolve(this.config.uploadsDir, safeUploadRootId);
    const assetPath = path.resolve(root, ...safeRelativePath.split("/"));
    if (!isPathInside(root, assetPath)) return "private";
    const rows = this.db
      .prepare(
        "SELECT source_path, visibility, deleted_at FROM pages WHERE source_path IS NOT NULL",
      )
      .all();
    const matchingPages = rows.filter((row) => {
      if (row.deleted_at) return false;
      const sourcePath = path.resolve(row.source_path || "");
      if (!isPathInside(root, sourcePath)) return false;
      return (
        assetPath === sourcePath ||
        isPathInside(path.dirname(sourcePath), assetPath)
      );
    });
    if (!matchingPages.length) return "private";
    return matchingPages.some(
      (row) => normalizeVisibility(row.visibility) === "public",
    )
      ? "public"
      : "private";
  }

  async readPageHtml(page) {
    return fs.readFile(await this.resolveGeneratedPath(page), "utf8");
  }

  async readPageFile(page) {
    return fs.readFile(await this.resolveGeneratedPath(page));
  }

  async resolveGeneratedPath(page) {
    if (!page?.generatedPath) return page?.generatedPath;
    return this.resolveManagedPath(page.generatedPath);
  }

  async resolveManagedPath(storedPath) {
    if (!storedPath) return storedPath;
    if (await pathExists(storedPath)) return storedPath;
    const normalized = String(storedPath || "").replace(/\\/g, "/");
    const fileName = path.basename(storedPath);
    const candidates = [];
    if (normalized.includes("/trash/"))
      candidates.push(path.join(this.trashDir(), "generated", fileName));
    if (normalized.includes("/pages/") || !candidates.length)
      candidates.push(path.join(this.config.generatedDir, fileName));
    for (const candidate of candidates) {
      if (candidate !== storedPath && (await pathExists(candidate)))
        return candidate;
    }
    return storedPath;
  }

  async importBuffer({
    fileName,
    buffer,
    relativePath = "",
    visibility = "public",
  }) {
    const [page] = await this.importUploadFiles([
      { fileName, buffer, relativePath, visibility },
    ]);
    return page;
  }

  pendingUploadDir() {
    return path.join(this.config.dataDir, "pending-uploads");
  }

  stagedUploadDir(uploadId) {
    const safeUploadId = String(uploadId || "");
    if (!/^[a-z0-9-]{20,80}$/i.test(safeUploadId)) {
      throw new Error("Invalid upload batch");
    }
    return path.join(this.pendingUploadDir(), safeUploadId);
  }

  stagedUploadManifestPath(uploadId) {
    return path.join(this.stagedUploadDir(uploadId), "manifest.json");
  }

  async readStagedUploadManifest(uploadId) {
    try {
      return JSON.parse(
        await fs.readFile(this.stagedUploadManifestPath(uploadId), "utf8"),
      );
    } catch {
      throw new Error("Upload batch not found");
    }
  }

  async stageUploadFiles(files = []) {
    const normalized = files
      .filter((file) => file?.buffer)
      .map((file) => {
        const relativePath = cleanUploadPath(
          file.relativePath || file.fileName,
          file.fileName || "file",
        );
        return {
          fileName:
            path.posix.basename(relativePath) ||
            path.basename(file.fileName || "file"),
          relativePath,
          buffer: file.buffer,
        };
      });
    const uniquePaths = new Set();
    for (const file of normalized) {
      const key = file.relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (uniquePaths.has(key)) throw Object.assign(new Error(`文件路径重复：${file.relativePath}，请为文件设置不同名称`), {statusCode:400,code:"DOCUMENT_ACCESS"});
      uniquePaths.add(key);
    }
    const managedFiles = normalized.filter((file) =>
      isManagedFile(file.relativePath),
    );
    if (!managedFiles.length) {
      return {
        uploadId: "",
        documents: [],
        fileCount: normalized.length,
        assetCount: normalized.length,
        totalSize: normalized.reduce(
          (sum, file) => sum + file.buffer.length,
          0,
        ),
      };
    }

    const uploadId = crypto.randomUUID();
    const uploadRoot = this.stagedUploadDir(uploadId);
    await fs.mkdir(uploadRoot, { recursive: true });

    for (const file of normalized) {
      const destination = safeDestination(uploadRoot, file.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.buffer);
    }

    const documents = managedFiles.map((file) => {
      const fileType = managedFileType(file.relativePath);
      const title = isHtmlFile(file.relativePath)
        ? parseHtmlMetadata(file.buffer.toString("utf8"), file.fileName).title
        : documentTitleFromFileName(file.fileName);
      return {
        id: crypto.randomUUID(),
        relativePath: file.relativePath,
        fileName: file.fileName,
        title,
        fileType,
        visibility: "public",
        directoryName: parentDirectoryNameFromRelative(file.relativePath),
        size: file.buffer.length,
      };
    });

    const manifest = {
      uploadId,
      createdAt: nowIso(),
      files: normalized.map((file) => ({
        fileName: file.fileName,
        relativePath: file.relativePath,
        size: file.buffer.length,
      })),
      documents,
    };
    await fs.writeFile(
      this.stagedUploadManifestPath(uploadId),
      JSON.stringify(manifest, null, 2),
    );

    return {
      uploadId,
      documents,
      fileCount: normalized.length,
      assetCount: Math.max(0, normalized.length - managedFiles.length),
      totalSize: normalized.reduce((sum, file) => sum + file.buffer.length, 0),
    };
  }

  async confirmStagedUpload(uploadId, options = {}) {
    const manifest = await this.readStagedUploadManifest(uploadId);
    const uploadRoot = this.stagedUploadDir(uploadId);
    const editsById = new Map(
      (options.documents || []).map((item) => [String(item.id || ""), item]),
    );
    const documentsByPath = new Map(
      manifest.documents.map((document) => [document.relativePath, document]),
    );
    const importFiles = [];

    for (const file of manifest.files) {
      const source = safeDestination(uploadRoot, file.relativePath);
      const buffer = await fs.readFile(source);
      const document = documentsByPath.get(file.relativePath);
      if (!document) {
        importFiles.push({
          fileName: file.fileName,
          relativePath: file.relativePath,
          buffer,
        });
        continue;
      }

      const edit = editsById.get(document.id) || {};
      const fileName = editableUploadFileName(edit.fileName, document.fileName);
      const title = String(edit.title || document.title || "").trim();
      const visibility = normalizeVisibility(
        edit.visibility || document.visibility,
      );
      importFiles.push({
        id: document.id,
        title,
        fileName,
        visibility,
        homepageListed: edit.homepageListed ?? true,
        passwordAction: edit.passwordAction ?? "keep",
        password: edit.password,
        relativePath: replaceRelativeBasename(document.relativePath, fileName),
        buffer,
      });
    }

    const created = await this.importUploadFiles(importFiles);
    await fs.rm(uploadRoot, { recursive: true, force: true });
    return created;
  }

  async cancelStagedUpload(uploadId) {
    await fs.rm(this.stagedUploadDir(uploadId), {
      recursive: true,
      force: true,
    });
  }

  async importUploadFiles(files = []) {
    const normalized = files
      .filter((file) => file?.buffer)
      .map((file) => {
        const relativePath = cleanUploadPath(
          file.relativePath || file.fileName,
          file.fileName || "file",
        );
        return {
          ...file,
          id: file.id || crypto.randomUUID(),
          title: String(file.title || "").trim(),
          visibility: normalizeVisibility(file.visibility),
          fileName:
            path.posix.basename(relativePath) ||
            path.basename(file.fileName || "file"),
          relativePath,
          buffer: file.buffer,
        };
      });
    const uniquePaths = new Set();
    for (const file of normalized) {
      const key = file.relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (uniquePaths.has(key)) throw Object.assign(new Error(`文件路径重复：${file.relativePath}，请为文件设置不同名称`), {statusCode:400,code:"DOCUMENT_ACCESS"});
      uniquePaths.add(key);
    }
    const managedFiles = normalized.filter((file) =>
      isManagedFile(file.relativePath),
    );
    const htmlFiles = managedFiles.filter((file) =>
      isHtmlFile(file.relativePath),
    );
    if (!managedFiles.length) return [];

    for (const file of managedFiles) file.accessPolicy = await this.access.policy(file);
    const uploadRootId = crypto.randomUUID();
    const uploadRoot = path.join(this.config.uploadsDir, uploadRootId);
    const hasFolderAssets =
      normalized.length > htmlFiles.length ||
      normalized.some((file) => file.relativePath.includes("/"));
    await fs.mkdir(uploadRoot, { recursive: true });

    const stored = new Map();
    for (const file of normalized) {
      const destination = safeDestination(uploadRoot, file.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.buffer);
      stored.set(file.relativePath, destination);
    }

    // Resolve the complete batch before publishing any row.
    for (const file of managedFiles) file.resources = isHtmlFile(file.relativePath) ? await this.access.resources(stored.get(file.relativePath), file.buffer.toString("utf8")) : [];
    for (const file of managedFiles) {
      if (!file.accessPolicy.accessPasswordHash && file.accessPolicy.visibility !== "private") continue;
      const conflict = managedFiles.find(other => other !== file && other.accessPolicy.visibility === "public" && !other.accessPolicy.accessPasswordHash && other.resources.some(resource => file.resources.includes(resource)));
      if (conflict) throw Object.assign(new Error(`附件与公开文档 ${conflict.fileName} 共享，请统一设置密码或整理到独立目录`), { statusCode: 409, code: "DOCUMENT_ACCESS" });
    }
    const created = [];
    for (const file of managedFiles) {
      const sourcePath = stored.get(file.relativePath);
      if (isHtmlFile(file.relativePath)) {
        const content = file.buffer.toString("utf8");
        created.push(
          await this.createPageFromContent({
            id: file.id || crypto.randomUUID(),
            fileName: file.fileName,
            content,
            title: file.title,
            visibility: file.visibility,
            accessPolicy: file.accessPolicy,
            resources: file.resources,
            sourceType: "upload",
            sourcePath,
            directoryName: parentDirectoryNameFromRelative(file.relativePath),
            rawMtimeMs: null,
            assetBaseUrl: hasFolderAssets
              ? assetBaseUrl(uploadRootId, file.relativePath)
              : "",
          }),
        );
        continue;
      }
      created.push(
        await this.createDocumentAsset({
          id: file.id || crypto.randomUUID(),
          fileName: file.fileName,
          title: file.title,
          visibility: file.visibility,
            accessPolicy: file.accessPolicy,
            resources: file.resources,
          buffer: file.buffer,
          sourceType: "upload",
          sourcePath,
          directoryName: parentDirectoryNameFromRelative(file.relativePath),
          rawMtimeMs: null,
          fileType: managedFileType(file.relativePath),
        }),
      );
    }
    return created;
  }

  async addSamplePages() {
    const samples = [
      {
        fileName: "school-admission-page.html",
        title: "春季招生落地页",
        body: "<h1>春季招生落地页</h1><p>这是一个已经导入系统的 HTML 页面。打开在线编辑后，可以直接点击正文、标题和列表文字进行修改。</p><h2>核心信息</h2><ul><li>课程名称：AI 编程体验营</li><li>报名时间：2026 年春季批次</li><li>交付形式：本地预览 + 在线编辑</li></ul><blockquote>编辑保存后，后端会重新生成对应的本地 HTML 文件。</blockquote>",
      },
      {
        fileName: "geo-report-template.html",
        title: "GEO 诊断报告模板",
        body: "<h1>GEO 诊断报告模板</h1><p>页面列表需要展示文件名、页面标题、上传时间和生成后的本地 URL。编辑体验以文档为中心，减少表单感。</p><h2>页面模块</h2><ol><li>品牌可见度摘要</li><li>关键词覆盖情况</li><li>内容优化建议</li></ol>",
      },
      {
        fileName: "internal-notice.html",
        title: "内部通知页",
        body: "<h1>内部通知页</h1><p>轻量页面也可以作为 HTML 资产进入统一管理，后续可增加版本历史、发布状态和目录归档。</p><h2>待办</h2><ul><li>确认输出目录</li><li>确认 Docker volume 映射</li><li>接入 Tiptap 编辑器</li></ul>",
      },
    ];

    const created = [];
    for (const sample of samples) {
      const content = composeDocument(sample.title, sample.body);
      created.push(
        await this.createPageFromContent({
          id: crypto.randomUUID(),
          fileName: sample.fileName,
          content,
          sourceType: "upload",
          sourcePath: null,
          directoryName: "",
          rawMtimeMs: null,
          visibility: "public",
        }),
      );
    }
    return created;
  }

  async createPageFromContent({
    id,
    fileName,
    content,
    title,
    sourceType,
    sourcePath,
    directoryName,
    rawMtimeMs,
    visibility = "public",
    accessPolicy, resources,
    assetBaseUrl: pageAssetBaseUrl = "",
  }) {
    const createdAt = nowIso();
    const parsed = parseHtmlMetadata(content, fileName);
    const pageTitle = String(title || "").trim() || parsed.title;
    const slug = this.uniqueManagedSlug();
    const generatedPath = path.join(
      this.config.generatedDir,
      generatedFileNameForPage({ slug, fileName, createdAt }),
    );
    const generatedContent = this.prepareGeneratedHtml(
      content,
      pageAssetBaseUrl,
    );
    await fs.writeFile(generatedPath, generatedContent);
    const info = {
      id,
      slug,
      fileName,
      title: pageTitle,
      fileType: "html",
      mimeType: generatedMimeType("html"),
      sourceType,
      sourcePath,
      directoryName,
      size: Buffer.byteLength(generatedContent),
      status: "published",
      createdAt,
      updatedAt: createdAt,
      revision: 1,
      generatedPath,
      rawMtimeMs,
      checksum: checksum(content),
      edited: 0,
      accessCount: 0,
      visibility: normalizeVisibility(visibility),
      ...(accessPolicy || {}),
    };
    const owned = resources || (info.fileType === "html" ? await this.access.resources(sourcePath, content) : []);
    this.insertPage(info);
    this.access.registerResources(id, owned);
    return this.getPage(id);
  }

  async createDocumentAsset({
    id,
    fileName,
    title,
    buffer,
    sourceType,
    sourcePath,
    directoryName,
    rawMtimeMs,
    fileType,
    visibility = "public",
    accessPolicy, resources,
  }) {
    const createdAt = nowIso();
    const slug = this.uniqueManagedSlug();
    const generatedPath = path.join(
      this.config.generatedDir,
      generatedFileNameForAsset({ slug, fileName, createdAt }, "pdf"),
    );
    await fs.mkdir(path.dirname(generatedPath), { recursive: true });
    if (fileType === "pdf") {
      await fs.writeFile(generatedPath, buffer);
    } else if (fileType === "word") {
      await this.convertWordToPdf(sourcePath, generatedPath);
    } else {
      throw new Error(`Unsupported document type: ${fileType}`);
    }
    const info = {
      id,
      slug,
      fileName,
      title: String(title || "").trim() || documentTitleFromFileName(fileName),
      fileType,
      mimeType: generatedMimeType(fileType),
      sourceType,
      sourcePath,
      directoryName,
      size: Buffer.byteLength(buffer),
      status: "published",
      createdAt,
      updatedAt: createdAt,
      revision: 1,
      generatedPath,
      rawMtimeMs,
      checksum: checksum(buffer),
      edited: 0,
      accessCount: 0,
      visibility: normalizeVisibility(visibility),
      ...(accessPolicy || {}),
    };
    this.insertPage(info);
    this.access.registerResources(id, resources || []);
    return this.getPage(id);
  }

  async convertWordToPdf(sourcePath, generatedPath) {
    const converter =
      this.config.officeConverterBin ||
      process.env.TOKDOC_SOFFICE_BIN ||
      process.env.TOKHTML_SOFFICE_BIN ||
      "soffice";
    const tempDir = await fs.mkdtemp(
      path.join(this.config.dataDir, "convert-"),
    );
    const expectedOutput = path.join(
      tempDir,
      `${basenameWithoutExtension(sourcePath)}.pdf`,
    );
    try {
      await execFileAsync(
        converter,
        [
          "--headless",
          "--convert-to",
          "pdf:writer_pdf_Export",
          "--outdir",
          tempDir,
          sourcePath,
        ],
        {
          timeout: 120000,
        },
      );
      await fs.rename(expectedOutput, generatedPath);
    } catch (error) {
      const conversionError = new Error(
        `Word conversion failed: ${error.message}`,
      );
      conversionError.code = "WORD_CONVERSION_FAILED";
      throw conversionError;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  insertPage(info) {
    this.db
      .prepare(
        `INSERT INTO pages (
          id, slug, file_name, title, source_type, source_path, directory_name, size, status,
          created_at, updated_at, revision, generated_path, file_type, mime_type, raw_mtime_ms, checksum, edited, access_count, visibility, homepage_listed, access_password_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        info.id,
        info.slug,
        info.fileName,
        info.title,
        info.sourceType,
        info.sourcePath,
        info.directoryName,
        info.size,
        info.status,
        info.createdAt,
        info.updatedAt,
        info.revision,
        info.generatedPath,
        info.fileType,
        info.mimeType,
        info.rawMtimeMs,
        info.checksum,
        info.edited,
        info.accessCount,
        normalizeVisibility(info.visibility),
        Number(info.homepageListed ?? true),
        info.accessPasswordHash || "",
      );
  }

  prepareGeneratedHtml(content, pageAssetBaseUrl = "") {
    const withAssets = injectAssetBase(content, pageAssetBaseUrl);
    return injectTrackingCode(withAssets, this.getSettings().trackingCode);
  }

  getSettings() {
    const auth = this.getAuthSettings(true);
    const rows = this.db.prepare("SELECT key, value FROM settings").all();
    const settings = {
      trackingCode: "",
      authUsername: auth.authUsername,
      adminPath: this.getAdminPath(),
      siteName: defaultSiteName,
      adminName: defaultAdminName,
      publicSeoTitle: defaultSiteName,
      publicSeoDescription: defaultPublicSeoDescription,
      publicSeoKeywords: defaultPublicSeoKeywords,
      publicHomepageEnabled: true,
      publicNavigation: defaultPublicNavigation(),
      publicLogoUrl: "",
      publicBrandCaption: defaultBrandCaption,
      remoteSyncEnabled: false,
      remoteSyncUrl: "",
      remoteSyncHasToken: false,
    };
    for (const row of rows) {
      if (row.key === "tracking_code") settings.trackingCode = row.value || "";
      if (row.key === "site_name")
        settings.siteName = row.value || defaultSiteName;
      if (row.key === "admin_name")
        settings.adminName = row.value || defaultAdminName;
      if (row.key === "public_seo_title")
        settings.publicSeoTitle =
          row.value || settings.siteName || defaultSiteName;
      if (row.key === "public_seo_description")
        settings.publicSeoDescription =
          row.value || defaultPublicSeoDescription;
      if (row.key === "public_seo_keywords")
        settings.publicSeoKeywords = row.value || defaultPublicSeoKeywords;
      if (row.key === "public_homepage_enabled")
        settings.publicHomepageEnabled = row.value !== "0";
      if (row.key === "public_navigation") {
        try { settings.publicNavigation = validatePublicNavigation(JSON.parse(row.value)); }
        catch { settings.publicNavigation = defaultPublicNavigation(); }
      }
      if (row.key === "public_logo_url") settings.publicLogoUrl = isPublicUrl(row.value) ? row.value : "";
      if (row.key === "public_brand_caption") settings.publicBrandCaption = row.value;
      if (row.key === "remote_sync_enabled")
        settings.remoteSyncEnabled = row.value === "1";
      if (row.key === "remote_sync_url")
        settings.remoteSyncUrl = row.value || "";
      if (row.key === "remote_sync_token")
        settings.remoteSyncHasToken = Boolean(row.value);
    }
    return settings;
  }

  getPublicSettings() {
    const settings = this.getSettings();
    return {
      siteName: settings.siteName,
      adminName: settings.adminName,
      publicSeoTitle: settings.publicSeoTitle,
      publicSeoDescription: settings.publicSeoDescription,
      publicSeoKeywords: settings.publicSeoKeywords,
      publicHomepageEnabled: settings.publicHomepageEnabled,
      publicNavigation: settings.publicNavigation.filter(item => item.enabled),
      publicLogoUrl: settings.publicLogoUrl,
      publicBrandCaption: settings.publicBrandCaption,
    };
  }

  getRemoteSyncSettings(includeSensitive = false) {
    const settings = this.getSettings();
    if (includeSensitive)
      settings.remoteSyncToken = this.settingValue("remote_sync_token");
    return settings;
  }

  async saveSettings(settings = {}) {
    const brand = validateBrandSettings(settings);
    const navigation = Object.hasOwn(settings, "publicNavigation")
      ? validatePublicNavigation(settings.publicNavigation) : null;
    const now = nowIso();
    this.ensureAuthSettings();
    if (Object.prototype.hasOwnProperty.call(settings, "trackingCode")) {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run("tracking_code", String(settings.trackingCode || ""), now);
    }
    if (Object.prototype.hasOwnProperty.call(settings, "siteName")) {
      this.setSetting(
        "site_name",
        String(settings.siteName || defaultSiteName).trim() || defaultSiteName,
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "adminName")) {
      this.setSetting(
        "admin_name",
        String(settings.adminName || defaultAdminName).trim() ||
          defaultAdminName,
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "publicSeoTitle")) {
      this.setSetting(
        "public_seo_title",
        String(settings.publicSeoTitle || "").trim(),
        now,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, "publicSeoDescription")
    ) {
      this.setSetting(
        "public_seo_description",
        String(settings.publicSeoDescription || "").trim(),
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "publicSeoKeywords")) {
      this.setSetting(
        "public_seo_keywords",
        String(settings.publicSeoKeywords || "").trim(),
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "authUsername")) {
      const username = String(settings.authUsername || "").trim();
      if (username) this.setSetting("auth_username", username, now);
    }
    if (Object.prototype.hasOwnProperty.call(settings, "authPassword")) {
      const password = String(settings.authPassword || "");
      if (password)
        this.setSetting("auth_password_hash", hashPassword(password), now);
    }
    if (Object.prototype.hasOwnProperty.call(settings, "adminPath")) {
      this.setSetting(
        "admin_path",
        normalizeAdminPath(settings.adminPath || defaultAdminPath),
        now,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, "publicHomepageEnabled")
    ) {
      this.setSetting(
        "public_homepage_enabled",
        settings.publicHomepageEnabled ? "1" : "0",
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "remoteSyncEnabled")) {
      this.setSetting(
        "remote_sync_enabled",
        settings.remoteSyncEnabled ? "1" : "0",
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "remoteSyncUrl")) {
      this.setSetting(
        "remote_sync_url",
        String(settings.remoteSyncUrl || "").trim(),
        now,
      );
    }
    if (Object.prototype.hasOwnProperty.call(settings, "remoteSyncToken")) {
      const token = String(settings.remoteSyncToken || "").trim();
      if (token) this.setSetting("remote_sync_token", token, now);
    }
    if (navigation) this.setSetting("public_navigation", JSON.stringify(navigation), now);
    if (Object.hasOwn(brand, "publicLogoUrl")) this.setSetting("public_logo_url", brand.publicLogoUrl, now);
    if (Object.hasOwn(brand, "publicBrandCaption")) this.setSetting("public_brand_caption", brand.publicBrandCaption, now);
    return this.getSettings();
  }

  setSetting(key, value, updatedAt = nowIso()) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedAt);
  }

  settingValue(key) {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)
        ?.value || ""
    );
  }

  getAdminPath() {
    if (this.config.adminPathOverride)
      return safeAdminPath(this.config.adminPathOverride);
    return safeAdminPath(this.settingValue("admin_path") || defaultAdminPath);
  }

  ensureAuthSettings() {
    const now = nowIso();
    const initialUsername =
      String(this.config.initialAuthUsername || defaultAuthUsername).trim() ||
      defaultAuthUsername;
    const initialPassword =
      this.config.initialAuthPassword || defaultAuthPassword;
    if (!this.settingValue("auth_username"))
      this.setSetting("auth_username", initialUsername, now);
    if (!this.settingValue("auth_password_hash"))
      this.setSetting("auth_password_hash", hashPassword(initialPassword), now);
    if (!this.settingValue("auth_secret"))
      this.setSetting(
        "auth_secret",
        crypto.randomBytes(32).toString("base64url"),
        now,
      );
  }

  getAuthSettings(includeSensitive = false) {
    this.ensureAuthSettings();
    const authSettings = {
      authUsername: this.settingValue("auth_username"),
    };
    if (includeSensitive) {
      authSettings.authPasswordHash = this.settingValue("auth_password_hash");
      authSettings.authSecret = this.settingValue("auth_secret");
    }
    return authSettings;
  }

  verifyCredentials(username, password) {
    const authSettings = this.getAuthSettings(true);
    return (
      String(username || "") === authSettings.authUsername &&
      verifyPassword(password || "", authSettings.authPasswordHash)
    );
  }

  createSessionToken(username) {
    const authSettings = this.getAuthSettings(true);
    const payload = Buffer.from(
      JSON.stringify({ username, issuedAt: Date.now() }),
    ).toString("base64url");
    return `${payload}.${signSessionPayload(payload, authSettings)}`;
  }

  verifySessionToken(token) {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature) return null;
    const authSettings = this.getAuthSettings(true);
    const expected = signSessionPayload(payload, authSettings);
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (
      expectedBuffer.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
    )
      return null;
    try {
      const session = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (session.username !== authSettings.authUsername) return null;
      return { username: session.username };
    } catch {
      return null;
    }
  }

  incrementAccessCount(id) {
    this.analytics.record(id);
    return this.getPage(id);
  }

  uniqueSlug(base, pageId = null) {
    let slug = base || "page";
    let index = 2;
    while (true) {
      const row = this.db
        .prepare("SELECT id FROM pages WHERE slug = ?")
        .get(slug);
      if (!row || row.id === pageId) return slug;
      slug = `${base}-${index}`;
      index += 1;
    }
  }

  uniqueManagedSlug() {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const slug = buildManagedSlug();
      const row = this.db
        .prepare("SELECT id FROM pages WHERE slug = ?")
        .get(slug);
      if (!row) return slug;
    }
    throw new Error("Unable to generate a unique page URL");
  }

  listWatchDirs() {
    return this.db
      .prepare("SELECT * FROM watch_dirs ORDER BY created_at ASC")
      .all()
      .map(rowToWatchDir);
  }

  getWatchDir(id) {
    return rowToWatchDir(
      this.db.prepare("SELECT * FROM watch_dirs WHERE id = ?").get(id),
    );
  }

  async addWatchDir({
    path: watchPath,
    name,
    allowWrite = false,
    createIfMissing = true,
  }) {
    const absolutePath = path.resolve(watchPath);
    if (createIfMissing) await fs.mkdir(absolutePath, { recursive: true });
    const existing = this.db
      .prepare("SELECT * FROM watch_dirs WHERE path = ?")
      .get(absolutePath);
    if (existing) return rowToWatchDir(existing);
    const now = nowIso();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO watch_dirs (id, path, name, allow_write, status, html_count, last_scan_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        absolutePath,
        name || path.basename(absolutePath),
        allowWrite ? 1 : 0,
        "active",
        0,
        null,
        now,
        now,
      );
    return this.getWatchDir(id);
  }

  async removeWatchDir(id) {
    const watchDir = this.getWatchDir(id);
    if (!watchDir) return null;
    this.db.prepare("DELETE FROM watch_dirs WHERE id = ?").run(id);
    return watchDir;
  }

  async rescanWatchDir(id) {
    const watchDir = this.getWatchDir(id);
    if (!watchDir) throw new Error("Watch directory not found");
    const now = nowIso();
    let files = [];
    try {
      await fs.mkdir(watchDir.path, { recursive: true });
      files = await this.findHtmlFiles(watchDir.path);
      for (const filePath of files) {
        await this.upsertWatchedFile(filePath);
      }
    } catch {
      this.db
        .prepare(
          "UPDATE watch_dirs SET html_count = ?, last_scan_at = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(0, now, "error", now, id);
      return this.getWatchDir(id);
    }
    this.db
      .prepare(
        "UPDATE watch_dirs SET html_count = ?, last_scan_at = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .run(files.length, now, "updated", now, id);
    return this.getWatchDir(id);
  }

  async findHtmlFiles(dirPath) {
    const found = [];
    const visit = async (current) => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(next);
        if (entry.isFile() && isHtmlFile(entry.name)) found.push(next);
      }
    };
    await visit(dirPath);
    return found;
  }

  async upsertWatchedFile(filePath) {
    if (!isHtmlFile(filePath)) return null;
    const absolutePath = path.resolve(filePath);
    const stat = await fs.stat(absolutePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const nextChecksum = checksum(content);
    const existingRow = this.db
      .prepare(
        "SELECT * FROM pages WHERE source_path = ? ORDER BY deleted_at IS NULL DESC LIMIT 1",
      )
      .get(absolutePath);
    if (existingRow?.deleted_at) return rowToPage(existingRow);
    if (!existingRow) {
      return this.createPageFromContent({
        id: crypto.randomUUID(),
        fileName: path.basename(absolutePath),
        content,
        sourceType: "watch",
        sourcePath: absolutePath,
        directoryName: parentDirectoryNameFromPath(absolutePath),
        rawMtimeMs: Math.round(stat.mtimeMs),
      });
    }
    if (
      existingRow.checksum === nextChecksum &&
      existingRow.raw_mtime_ms === Math.round(stat.mtimeMs)
    ) {
      return rowToPage(existingRow);
    }
    const page = rowToPage(existingRow);
    await this.writeVersion(
      page,
      await this.readPageHtml(page),
      "external-change",
    );
    await fs.writeFile(page.generatedPath, this.prepareGeneratedHtml(content));
    const parsed = parseHtmlMetadata(content, page.fileName);
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE pages SET title = ?, size = ?, status = ?, updated_at = ?, revision = revision + 1,
         raw_mtime_ms = ?, checksum = ?, edited = 0 WHERE id = ?`,
      )
      .run(
        parsed.title,
        Buffer.byteLength(content),
        "published",
        now,
        Math.round(stat.mtimeMs),
        nextChecksum,
        page.id,
      );
    return this.getPage(page.id);
  }

  async markSourceDeleted(filePath) {
    const absolutePath = path.resolve(filePath);
    const row = this.db
      .prepare(
        "SELECT * FROM pages WHERE source_path = ? ORDER BY deleted_at IS NULL DESC LIMIT 1",
      )
      .get(absolutePath);
    if (!row) return null;
    const now = nowIso();
    this.db
      .prepare("UPDATE pages SET status = ?, updated_at = ? WHERE id = ?")
      .run("missing", now, row.id);
    return this.getPage(row.id);
  }

  async savePageContent(id, options) {
    if (this.writingPages.has(id)) throw Object.assign(new Error("Revision conflict"), {code:"REVISION_CONFLICT",page:this.getPage(id)});
    this.writingPages.add(id);
    try { return await this.savePageContentUnlocked(id, options); }
    finally { this.writingPages.delete(id); }
  }

  async savePageContentUnlocked(
    id,
    { html, body, title, revision, reason = "autosave" },
  ) {
    const page = this.getPage(id);
    if (!page || page.deletedAt) {
      const error = new Error("Page not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (page.fileType !== "html") {
      const error = new Error("Document assets cannot be edited online");
      error.code = "DOCUMENT_NOT_EDITABLE";
      throw error;
    }
    if (revision != null && Number(revision) !== Number(page.revision)) {
      const error = new Error("Revision conflict");
      error.code = "REVISION_CONFLICT";
      error.page = page;
      throw error;
    }
    const currentContent = await this.readPageHtml(page);
    await this.writeVersion(page, currentContent, reason);
    const nextContent = removeEditBridge(
      html || composeDocument(title || page.title, body || ""),
    );
    const owned = await this.access.resources(page.sourcePath, nextContent);
    const livePolicy = this.access.row(id);
    if (!livePolicy || livePolicy.deleted_at) throw Object.assign(new Error("Page not found"), {code:"NOT_FOUND"});
    this.access.conflict(id, { visibility: livePolicy.visibility, accessPasswordHash: livePolicy.access_password_hash }, owned);
    const previousResources = this.db.prepare("SELECT resource_path FROM page_resources WHERE page_id=?").all(id).map(row=>row.resource_path);
    // Reserve dependencies before yielding to filesystem writes.
    this.access.registerResources(id, [...new Set([...previousResources,...owned])]);
    let contentWritten = false;
    try {
    const parsed = parseHtmlMetadata(nextContent, page.fileName);
    const generatedPath = await this.resolveGeneratedPath(page);
    await fs.writeFile(generatedPath, nextContent);
    contentWritten = true;
    const watchDir = this.watchDirForPath(page.sourcePath);
    if (page.sourceType === "watch" && watchDir?.allowWrite) {
      await fs.writeFile(page.sourcePath, nextContent);
    }
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE pages SET title = ?, size = ?, status = ?, updated_at = ?, revision = revision + 1, generated_path = ?,
         checksum = ?, edited = 1 WHERE id = ?`,
      )
      .run(
        parsed.title,
        Buffer.byteLength(nextContent),
        "edited",
        now,
        generatedPath,
        checksum(nextContent),
        id,
      );
    this.access.registerResources(id, owned);
    return this.getPage(id);
    } catch (error) {
      if (!contentWritten) this.access.registerResources(id, previousResources);
      throw error;
    }
  }

  watchDirForPath(filePath) {
    if (!filePath) return null;
    return this.listWatchDirs()
      .sort((a, b) => b.path.length - a.path.length)
      .find((dir) =>
        path
          .resolve(filePath)
          .startsWith(`${path.resolve(dir.path)}${path.sep}`),
      );
  }

  async writeVersion(page, content, reason) {
    const id = crypto.randomUUID();
    const versionDir = path.join(this.config.versionsDir, page.id);
    await fs.mkdir(versionDir, { recursive: true });
    const contentPath = path.join(
      versionDir,
      `${String(page.revision).padStart(5, "0")}-${Date.now()}.html`,
    );
    await fs.writeFile(contentPath, content);
    this.db
      .prepare(
        "INSERT INTO versions (id, page_id, revision, title, content_path, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        page.id,
        page.revision,
        page.title,
        contentPath,
        reason,
        nowIso(),
      );
    return this.getVersion(id);
  }

  listVersions(pageId) {
    return this.db
      .prepare(
        "SELECT * FROM versions WHERE page_id = ? ORDER BY created_at DESC",
      )
      .all(pageId)
      .map((row) => ({
        id: row.id,
        pageId: row.page_id,
        revision: row.revision,
        title: row.title,
        reason: row.reason,
        createdAt: row.created_at,
        createdTime: displayTime(row.created_at),
      }));
  }

  getVersion(id) {
    const row = this.db.prepare("SELECT * FROM versions WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      pageId: row.page_id,
      revision: row.revision,
      title: row.title,
      contentPath: row.content_path,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  async restoreVersion(pageId, versionId) {
    const page = this.getPage(pageId);
    const version = this.getVersion(versionId);
    if (!page || !version || version.pageId !== pageId) {
      const error = new Error("Version not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    const content = await fs.readFile(version.contentPath, "utf8");
    return this.savePageContent(pageId, {
      html: content,
      revision: page.revision,
      reason: `restore-${version.revision}`,
    });
  }

  async deletePage(id) {
    const page = this.getPage(id);
    if (!page) return null;
    if (page.deletedAt) return page;
    this.access.revoke(id);
    const now = nowIso();
    const trashGeneratedDir = path.join(this.trashDir(), "generated");
    await fs.mkdir(trashGeneratedDir, { recursive: true });
    const trashPath = path.join(
      trashGeneratedDir,
      `${page.id}-${page.slug}.${generatedExtensionForPage(page)}`,
    );
    try {
      await fs.rename(await this.resolveGeneratedPath(page), trashPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.db
      .prepare(
        "UPDATE pages SET status = ?, generated_path = ?, deleted_at = ?, deleted_path = ?, updated_at = ? WHERE id = ?",
      )
      .run("trashed", trashPath, now, trashPath, now, id);
    this.access.revoke(id);
    return this.getPage(id);
  }

  async restoreDeletedPage(id) {
    const page = this.getPage(id);
    if (!page) return null;
    if (!page.deletedAt) return page;
    this.access.conflict(id, { visibility: page.visibility, accessPasswordHash: this.access.row(id).access_password_hash });
    const restoredPath = path.join(
      this.config.generatedDir,
      generatedFileNameForAsset(page, generatedExtensionForPage(page)),
    );
    await fs.mkdir(path.dirname(restoredPath), { recursive: true });
    let sourcePath = await this.resolveGeneratedPath(page);
    if (!(await pathExists(sourcePath)) && page.deletedPath)
      sourcePath = await this.resolveManagedPath(page.deletedPath);
    try {
      await fs.rename(sourcePath, restoredPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (page.deletedPath && page.deletedPath !== sourcePath) {
        await fs.rename(page.deletedPath, restoredPath);
      } else {
        const notFound = new Error("Deleted file not found");
        notFound.code = "NOT_FOUND";
        throw notFound;
      }
    }
    try { this.access.conflict(id, { visibility: page.visibility, accessPasswordHash: this.access.row(id).access_password_hash }); }
    catch (error) { await fs.rename(restoredPath, sourcePath); throw error; }
    const now = nowIso();
    const status = page.edited ? "edited" : "published";
    this.db
      .prepare(
        "UPDATE pages SET status = ?, generated_path = ?, deleted_at = NULL, deleted_path = NULL, updated_at = ? WHERE id = ?",
      )
      .run(status, restoredPath, now, id);
    this.access.revoke(id);
    return this.getPage(id);
  }
}
