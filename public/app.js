import {
  escapeHtml as esc,
  icon,
  fileIcon,
  formatSize,
  formatDate,
  paginationHtml,
  initShell,
  toast,
  wireDialog,
  confirmAction,
  openMenu,
  notice,
} from "./ui.js?v=202610271";
const $ = (selector) => document.querySelector(selector);
const labels = {
  upload: "上传文档",
  analytics: "数据分析",
  all: "全部文档",
  other: "其它文档",
  html: "HTML文档",
  pdf: "PDF文档",
  word: "Word文档",
  trash: "回收站",
};
const initialPath = location.pathname.replace(/\/+$/, "");
const isSettingsPage = /^\/[^/]+\/settings$/.test(initialPath);
let adminBase = isSettingsPage ? initialPath.slice(0, -9) : initialPath;
let session = false,
  sessionEpoch = 0,
  settings = {},
  runtime = {},
  pages = [],
  watchDirs = [],
  stats = {},
  facets = {},
  pagination = { page: 1, pageSize: 20, total: 0, totalPages: 1 };
let filters = readFilters(),
  requestSerial = 0,
  searchTimer,
  settingsDirty = false,
  settingsSaving = false;
let metadataReady = false,
  settingsEditSerial = 0,
  addingSamples = false;
let navigationDraft = [], navigationSerial = 0;
let logoUploading = false, logoUploadSerial = 0;
let previewPage = null,
  previewSerial = 0,
  listScroll = 0,
  listFocus = "",
  historyPage = null,
  historySerial = 0;
let stagedUpload = null,
  completedUpload = null,
  activeUploadRequest = null,
  uploadCancelled = false,
  committing = false,
  cancelling = false,
  uploadUnknown = false;
const busyPages = new Set();
let analyticsData = null, analyticsChartWidth = 0;
function readFilters() {
  const p = new URLSearchParams(location.search);
  return {
    view: ["analytics", "analytics-details"].includes(p.get("view")) ? p.get("view") : p.get("view") === "documents" || [...p.keys()].some(key => ["q", "type", "scope", "status", "directory", "directoryEmpty", "visibility", "accessMode", "password", "sort", "page", "preview"].includes(key)) ? "documents" : "upload",
    analyticsDays: [7, 30, 90].includes(Number(p.get("days"))) ? Number(p.get("days")) : 30,
    ranking: p.get("ranking") === "today" ? "today" : "total",
    q: (p.get("q") || "").trim(),
    type: ["html", "pdf", "word", "other"].includes(p.get("type"))
      ? p.get("type")
      : "all",
    status: ["published", "edited"].includes(p.get("status"))
      ? p.get("status")
      : "all",
    directory: p.get("directory") || "",
    directoryEmpty: p.get("directoryEmpty") === "1",
    visibility: ["public", "private"].includes(p.get("visibility"))
      ? p.get("visibility")
      : "all",
    accessMode: ["listed","unlisted","private"].includes(p.get("accessMode")) ? p.get("accessMode") : "all",
    password: ["yes","no"].includes(p.get("password")) ? p.get("password") : "all",
    sort: ["created_desc", "access_desc"].includes(p.get("sort"))
      ? p.get("sort")
      : "updated_desc",
    scope: p.get("scope") === "trash" ? "trash" : "active",
    page: Math.max(1, Math.trunc(Number(p.get("page"))) || 1),
    preview: p.get("preview") || "",
  };
}
function queryString() {
  const p = new URLSearchParams();
  if (["analytics", "analytics-details"].includes(filters.view)) {
    p.set("view", filters.view);
    if (filters.analyticsDays !== 30) p.set("days", String(filters.analyticsDays));
    if (filters.view === "analytics-details") {
      p.set("ranking", filters.ranking);
      if (filters.page > 1) p.set("page", String(filters.page));
    }
    return p;
  }
  for (const key of [
    "view",
    "q",
    "type",
    "status",
    "directory",
    "visibility",
    "accessMode",
    "password",
    "sort",
    "scope",
    "page",
    "preview",
  ]) {
    const value = filters[key];
    const defaults = {
      view: "upload",
      type: "all",
      status: "all",
      visibility: "all",
      accessMode: "all",
      password: "all",
      sort: "updated_desc",
      scope: "active",
      page: 1,
    };
    if (value !== "" && value !== undefined && value !== defaults[key])
      p.set(key, String(value));
  }
  if (filters.directoryEmpty) {
    p.delete("directory");
    p.set("directoryEmpty", "1");
  }
  return p;
}
function writeUrl(push = false, extra = {}) {
  const query = queryString();
  const url = `${adminBase}${isSettingsPage ? "/settings" : ""}${query.size ? "?" + query : ""}${isSettingsPage ? location.hash : ""}`;
  history[push ? "pushState" : "replaceState"](
    { ...history.state, ...extra },
    "",
    url,
  );
}
function apiUrl(path) {
  return `${adminBase}${path}`;
}
async function api(path, options = {}) {
  const epoch = sessionEpoch;
  const response = await fetch(apiUrl(path), {
    credentials: "same-origin",
    ...options,
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== "/api/login" &&
      epoch === sessionEpoch
    )
      showLogin("登录已失效，请重新登录。");
    throw Object.assign(
      new Error(data.error || `请求失败：${response.status}`),
      { status: response.status, field: data.field },
    );
  }
  return data;
}
const json = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
function showError(error) {
  notice($("#globalError"), error.message || String(error), "刷新列表");
  toast(error.message || String(error), "error");
}
function showLogin(message = "") {
  $("#accessPassword").value = ""; accessPage = null;
  sessionEpoch++;
  logoUploadSerial++;
  logoUploading = false;
  session = false;
  metadataReady = false;
  requestSerial++;
  analyticsData = null;
  $("#analyticsContent").hidden = true;
  $("#rankingDetailsContent").hidden = true;
  historySerial++;
  previewSerial++;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  document.querySelectorAll("[popover]").forEach((menu) => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  });
  if (document.body.classList.contains("drawer-open"))
    $("#drawerClose").click();
  updateSaveState();
  document.body.dataset.auth = "guest";
  $("#bootScreen").hidden = true;
  $("#loginBackdrop").hidden = false;
  $("#loginError").textContent = message;
  $("#loginError").hidden = !message;
  $("#loginPassword").value = "";
  $("#loginUsername").focus();
}
function shell() {
  if (isSettingsPage) selectSettingsTab(location.hash.slice(1));
  const name = settings.adminName || "猎看文档系统";
  $("#adminBrandTitle").textContent = name;
  $("#loginTitle").textContent = `${name} 登录`;
  $("#loginBackdrop .brand-title").textContent = name;
  $("#adminHomeLink").href = adminBase;
  $("#settingsBackLink").href = `${adminBase}?view=documents`;
  $("#openSettings").href = `${adminBase}/settings`;
  $("#openSettings").classList.toggle("is-active", isSettingsPage);
  $("#authUserLabel").textContent = settings.authUsername || "管理员";
  const uploading = !isSettingsPage && filters.view === "upload" && !previewPage;
  const analyzing = !isSettingsPage && filters.view === "analytics" && !previewPage;
  const rankingDetails = !isSettingsPage && filters.view === "analytics-details" && !previewPage;
  $("#managerActions").hidden = isSettingsPage || uploading || analyzing || rankingDetails;
  $("#settingsActions").hidden = !isSettingsPage;
  $("#settingsPage").hidden = !isSettingsPage;
  $("#managerView").hidden = isSettingsPage || uploading || analyzing || rankingDetails || Boolean(previewPage);
  $("#uploadView").hidden = !uploading;
  $("#analyticsView").hidden = !analyzing;
  $("#analyticsDetailsView").hidden = !rankingDetails;
  $("#workspaceStats").hidden = analyzing || rankingDetails;
  const rankingTitle = filters.ranking === "today" ? "今日浏览明细" : "累计浏览明细";
  $("#rankingDetailsTitle").textContent = rankingTitle;
  const overviewQuery = `view=analytics${filters.analyticsDays !== 30 ? "&days=" + filters.analyticsDays : ""}`;
  $("#rankingDetailsBack").href = `${adminBase}?${overviewQuery}`;
  for (const mode of ["total", "today"]) $("#" + mode + "RankingDetailsLink").href = `${adminBase}?${overviewQuery.replace("view=analytics", "view=analytics-details")}&ranking=${mode}`;
  $("#uploadListLink").href = `${adminBase}?view=documents`;
  const title = isSettingsPage ? "系统设置" : rankingDetails ? rankingTitle : analyzing ? "数据分析" : uploading ? "上传文档" : "文档管理";
  $("#workspaceTitle").textContent = title;
  document.title = `${name} · ${title}`;
  const home = $("#openPublicHome");
  home.setAttribute(
    "aria-disabled",
    String(settings.publicHomepageEnabled === false),
  );
  home.title = settings.publicHomepageEnabled === false ? "公开首页已关闭" : "";
  if (settings.publicHomepageEnabled === false) home.removeAttribute("href");
  else home.href = "/";
  document.querySelectorAll("[data-nav-type]").forEach((el) => {
    const type = el.dataset.navType;
    el.href = `${adminBase}${type === "upload" ? "" : type === "analytics" ? "?view=analytics" : type === "all" ? "?view=documents" : type === "trash" ? "?scope=trash" : "?type=" + type}`;
    el.classList.toggle(
      "is-active",
      !isSettingsPage &&
        (analyzing || rankingDetails ? type === "analytics" : uploading ? type === "upload" : filters.scope === "trash" ? type === "trash" : type === filters.type),
    );
    if (el.classList.contains("is-active")) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}
async function loadMetadata() {
  const epoch = sessionEpoch;
  const [s, w] = await Promise.all([
    api("/api/settings"),
    api("/api/watch-dirs"),
  ]);
  if (epoch !== sessionEpoch || !session) return;
  settings = s.settings;
  runtime = s.runtime || {};
  watchDirs = w.watchDirs || [];
  metadataReady = true;
  updateSaveState();
  shell();
  if (isSettingsPage) {
    fillSettings();
    renderWatchDirs();
  }
}
function syncFilters() {
  if (document.activeElement !== $("#searchInput"))
    $("#searchInput").value = filters.q;
  $("#statusSelect").value = filters.status;
  $("#statusSelect").disabled = filters.scope === "trash";
  $("#visibilitySelect").value = filters.accessMode !== "all" ? filters.accessMode : filters.visibility;
  $("#passwordFilter").value = filters.password || "all";
  $("#sortSelect").value = filters.sort;
  const value = filters.directoryEmpty
    ? "root"
    : filters.directory
      ? "name:" + filters.directory
      : "all";
  $("#directorySelect").innerHTML =
    '<option value="all">全部目录</option>' +
    (facets.directories || [])
      .map(
        (item) =>
          `<option value="${esc(item.name ? "name:" + item.name : "root")}">${esc(item.name || "无目录")} (${Number(item.count)})</option>`,
      )
      .join("");
  if (
    value !== "all" &&
    ![...$("#directorySelect").options].some((o) => o.value === value)
  )
    $("#directorySelect").add(new Option(filters.directory || "无目录", value));
  $("#directorySelect").value = value;
}
function renderStats() {
  for (const [id, key] of [
    ["metricTotal", "all"],
    ["metricEditable", "editable"],
    ["metricToday", "todayCreated"],
    ["metricWatch", "watchDirs"],
  ])
    $("#" + id).textContent = Number(stats[key]) || 0;
  for (const [id, key] of [["metricTodayViews", "todayViews"], ["metricTotalViews", "totalViews"]]) {
    $("#" + id).textContent = stats[key] == null ? "-" : compactCount(stats[key]);
    $("#" + id).title = stats[key] == null ? "尚未加载" : countText(stats[key]);
  }
  $("#metricToday").title =
    "当前有效文档在本地今日入库的数量；删除后不计入，恢复后按原入库时间计入。";
  document.querySelectorAll("[data-count]").forEach((el) => {
    const type = el.dataset.count;
    el.textContent =
      type === "all"
        ? stats.all || 0
        : type === "trash"
          ? stats.trash || 0
          : stats.byType?.[type] || 0;
  });
}
function countText(value) { return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 }); }
function compactCount(value) {
  const n = Number(value) || 0;
  return n >= 1e8 ? `${countText(Math.round(n / 1e7) / 10)}亿` : n >= 1e4 ? `${countText(Math.round(n / 1e3) / 10)}万` : countText(n);
}
function renderAnalyticsChart(data) {
  const chart = $("#analyticsChart"), padding = getComputedStyle(chart);
  analyticsChartWidth = chart.clientWidth;
  const width = Math.max(260, chart.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight) || 800), height = 240;
  const left = 44, right = width - 16, top = 16, bottom = 208;
  const maximum = Math.max(1, ...data.trend.map(day => day.views || 0));
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
  const step = Math.max(1, Math.ceil(maximum / 4 / magnitude) * magnitude), ceiling = step * 4;
  const x = i => left + i * (right - left) / Math.max(1, data.trend.length - 1);
  const y = n => bottom - n / ceiling * (bottom - top);
  const grid = Array.from({ length: 5 }, (_, i) => `<line x1="${left}" y1="${y(i * step)}" x2="${right}" y2="${y(i * step)}" class="chart-grid"/><text x="${left - 10}" y="${y(i * step) + 4}" text-anchor="end">${compactCount(i * step)}</text>`).join("");
  const labelStep = Math.ceil((data.trend.length - 1) / (width < 500 ? 3 : 6));
  const dates = data.trend.map((day, i) => i % labelStep === 0 || i === data.trend.length - 1 ? `<text x="${x(i)}" y="234" text-anchor="${i === 0 ? "start" : i === data.trend.length - 1 ? "end" : "middle"}">${day.date.slice(5).replace("-", "/")}</text>` : "").join("");
  const points = data.trend.flatMap((day, i) => day.views === null ? [] : [{ ...day, x: x(i), y: y(day.views) }]);
  const line = points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const area = points.length ? `${line} L${points.at(-1).x},${bottom} L${points[0].x},${bottom} Z` : "";
  $("#analyticsChart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trendChartTitle trendChartDescription"><title id="trendChartTitle">近 ${data.days} 天浏览趋势</title><desc id="trendChartDescription">共 ${countText(data.summary.periodViews)} 次浏览，按日展示，详细数值可展开下方每日数据。</desc>${grid}${dates}<path d="${area}" class="chart-area"/><path d="${line}" class="chart-line"/>${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="${points.length > 31 ? 2 : 3}" class="chart-dot"><title>${p.date}：${countText(p.views)} 次浏览，${p.documents} 份文档</title></circle>`).join("")}</svg>${data.summary.periodViews ? "" : '<p class="chart-empty">所选时段暂无浏览记录</p>'}`;
}
function rankingTableHtml(mode, ranked, precise = false) {
  const prefix = mode === "total" ? "累计" : "今日";
  return ranked.length
    ? `<div class="table-scroll"><table class="analytics-table ranking-table"><caption class="sr-only">${prefix}文档浏览量降序排列</caption><thead><tr><th scope="col" class="rank-number">排名</th><th scope="col">文档</th><th scope="col" class="number">浏览量</th></tr></thead><tbody>${ranked.map(row => `<tr><td class="rank-number"><span class="${row.rank <= 3 ? "rank-leading" : ""}">${row.rank}</span></td><td><div class="ranking-name">${row.deleted ? `<span>${esc(row.title)}</span>` : `<a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${esc(row.title)}</a>`}<small>${esc(labels[row.fileType] || "其它文档")}${row.deleted ? " · 已移入回收站" : ""}</small></div></td><td class="number" title="${countText(row.views)}" aria-label="${countText(row.views)} 次浏览">${precise ? countText(row.views) : compactCount(row.views)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="analytics-empty">${prefix}暂无文档浏览记录</div>`;
}
function renderAnalyticsRanking(mode, data) {
  $("#" + mode + "Ranking").innerHTML = rankingTableHtml(mode, data.pages.slice(0, 10));
}
function renderAnalytics(data) {
  const s = data.summary;
  for (const [id, key] of [["Today", "todayViews"], ["Total", "totalViews"], ["Period", "periodViews"], ["Average", "dailyAverage"], ["Documents", "periodDocuments"], ["Yesterday", "yesterdayViews"]]) {
    const el = $("#analytics" + id);
    el.textContent = id === "Yesterday" && !s.yesterdayAvailable ? "-" : compactCount(s[key]);
    el.title = id === "Yesterday" && !s.yesterdayAvailable ? "昨日尚未开始记录" : countText(s[key]);
  }
  $("#analyticsPeriodLabel").textContent = `近 ${data.days} 天浏览量`;
  $("#analyticsYesterdayNote").textContent = !s.yesterdayAvailable ? "昨日尚未开始记录" : s.yesterdayComplete ? "上一个完整自然日" : "昨日仅记录部分时段";
  $("#analyticsComparison").textContent = !s.yesterdayAvailable ? "昨日尚未开始记录" : !s.yesterdayComplete ? "昨日不完整，暂不比较" : s.yesterdayViews
    ? s.todayViews === s.yesterdayViews ? "与昨日持平" : `较昨日${s.todayViews > s.yesterdayViews ? "增加" : "减少"} ${countText(Math.abs((s.todayViews - s.yesterdayViews) / s.yesterdayViews * 100))}%`
    : s.todayViews ? `较昨日增加 ${countText(s.todayViews)} 次` : "与昨日持平";
  $("#analyticsUpdated").textContent = `${data.timeZone} · 更新于 ${new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
  $("#todayRankingDate").textContent = data.today;
  renderAnalyticsChart(data);
  $("#analyticsDailyRows").innerHTML = data.trend.map(day => `<tr><td>${day.date}</td><td class="number">${day.views === null ? "未记录" : countText(day.views)}</td><td class="number">${day.documents === null ? "未记录" : countText(day.documents)}</td></tr>`).join("");
  for (const mode of ["total", "today"]) renderAnalyticsRanking(mode, data.rankings[mode]);
  $("#analyticsTypes").innerHTML = Object.entries(data.byType).map(([type, views]) => {
    const share = s.periodViews ? views / s.periodViews * 100 : 0;
    return `<div class="analytics-type"><span>${esc(labels[type])}</span><div class="type-track"><span style="width:${share}%"></span></div><strong title="${countText(views)}">${compactCount(views)}</strong><small>${countText(Math.round(share * 10) / 10)}%</small></div>`;
  }).join("");
  const began = new Date(data.trackingStartedAt).toLocaleString("zh-CN", { timeZone: data.timeZone, hour12: false });
  $("#analyticsMethod").textContent = `浏览量（PV）按成功打开文档的 GET 阅读请求统计，刷新和重复阅读会累计；编辑、密码验证页、附件及失败请求不计入。每日统计自 ${began} 开始，首日按实际记录时段统计，历史累计次数保留，每日明细无法回补。统计包含私有、仅链接及回收站文档的历史阅读；访客人数未采集。`;
}
async function loadAnalytics() {
  if (!session) return;
  const serial = ++requestSerial;
  const focused = document.activeElement;
  const ownsRecoveryFocus = focused === $("#refreshAnalytics") || (focused && $("#analyticsError").contains(focused));
  shell();
  $("#analyticsRange").value = String(filters.analyticsDays);
  $("#analyticsStatus").textContent = "正在加载浏览数据…";
  $("#analyticsError").hidden = true;
  $("#analyticsContent").hidden = true;
  $("#analyticsContent").setAttribute("aria-busy", "true");
  $("#refreshAnalytics").disabled = true;
  const params = new URLSearchParams({ days: filters.analyticsDays, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  try {
    const data = await api(`/api/analytics?${params}`);
    if (serial !== requestSerial || !session || filters.view !== "analytics") return;
    analyticsData = data;
    stats = data.documentStats;
    renderStats();
    $("#globalError").hidden = true;
    writeUrl();
    $("#analyticsContent").hidden = false;
    renderAnalytics(data);
    $("#analyticsStatus").textContent = data.summary.periodViews ? `已加载近 ${data.days} 天数据` : "";
    return true;
  } catch (error) {
    if (serial !== requestSerial || !session) return;
    $("#analyticsStatus").textContent = "浏览数据加载失败";
    notice($("#analyticsError"), error.message || "浏览数据加载失败", "重试");
    return false;
  } finally {
    if (serial === requestSerial) {
      $("#analyticsContent").setAttribute("aria-busy", "false");
      $("#refreshAnalytics").disabled = false;
      if (ownsRecoveryFocus && session && !$("#analyticsView").hidden && document.activeElement === document.body) {
        ($("#analyticsError").hidden ? $("#refreshAnalytics") : $("#analyticsError [data-retry]"))?.focus();
      }
    }
  }
}
async function loadRankingDetails() {
  if (!session) return;
  const serial = ++requestSerial;
  const focused = document.activeElement;
  const ownsRecoveryFocus = focused === $("#refreshRankingDetails") || (focused && $("#rankingDetailsError").contains(focused));
  shell();
  $("#rankingDetailsStatus").textContent = `正在加载${filters.ranking === "today" ? "今日" : "累计"}浏览明细…`;
  $("#rankingDetailsError").hidden = true;
  $("#rankingDetailsContent").hidden = true;
  $("#rankingDetailsContent").setAttribute("aria-busy", "true");
  $("#refreshRankingDetails").disabled = true;
  const params = new URLSearchParams({ mode: filters.ranking, page: filters.page, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  try {
    const data = await api(`/api/analytics/rankings?${params}`);
    if (serial !== requestSerial || !session || filters.view !== "analytics-details") return;
    stats = data.documentStats;
    renderStats();
    $("#globalError").hidden = true;
    filters.page = data.pagination.page;
    writeUrl();
    $("#rankingDetailsDescription").textContent = `${data.mode === "today" ? data.today + " · " : ""}${data.timeZone} · 按浏览量降序排列`;
    $("#rankingDetailsCount").textContent = `共 ${countText(data.pagination.total)} 份文档 · ${countText(data.views)} 次浏览`;
    $("#rankingDetailsTable").innerHTML = rankingTableHtml(data.mode, data.pages, true);
    $("#rankingDetailsPager").innerHTML = paginationHtml(data.pagination);
    $("#rankingDetailsPager").hidden = data.pagination.totalPages <= 1;
    $("#rankingDetailsContent").hidden = false;
    $("#rankingDetailsStatus").textContent = `已加载${data.mode === "today" ? "今日" : "累计"}浏览明细`;
    return true;
  } catch (error) {
    if (serial !== requestSerial || !session) return;
    $("#rankingDetailsStatus").textContent = "浏览明细加载失败";
    notice($("#rankingDetailsError"), error.message || "浏览明细加载失败", "重试");
    return false;
  } finally {
    if (serial === requestSerial) {
      $("#rankingDetailsContent").setAttribute("aria-busy", "false");
      $("#refreshRankingDetails").disabled = false;
      if (ownsRecoveryFocus && session && !$("#analyticsDetailsView").hidden && document.activeElement === document.body) {
        ($("#rankingDetailsError").hidden ? $("#refreshRankingDetails") : $("#rankingDetailsError [data-retry]"))?.focus();
      }
    }
  }
}
function renderRows() {
  const trash = filters.scope === "trash";
  $("#timeHeading").textContent = trash
    ? "删除时间"
    : filters.sort === "created_desc"
      ? "入库时间"
      : "更新时间";
  $("#pageRows").innerHTML = pages
    .map((page) => {
      const deleted = Boolean(page.deletedAt);
      const editable = page.canEdit && !deleted;
      const tone =
        page.status === "missing" ? "warning" : page.edited ? "" : "success";
      const state = deleted
        ? "回收站"
        : page.status === "missing"
          ? "源文件缺失"
          : page.edited
            ? "已编辑"
            : "已生成";
      const name = page.title || page.fileName || page.slug;
      const time = formatDate(
        trash
          ? page.deletedAt
          : filters.sort === "created_desc"
            ? page.createdAt
            : page.updatedAt,
      );
      return `<tr data-row-id="${esc(page.id)}"><td class="title-cell"><div class="doc-name">${fileIcon(page.fileType)}<div class="title-copy">${deleted ? `<span class="title-main">${esc(name)}</span>` : `<button class="title-main" type="button" data-action="preview" data-id="${esc(page.id)}" title="${esc(name)}">${esc(name)}</button>`}<span class="title-meta" title="${esc(page.fileName)}">${esc(page.fileName)} · ${formatSize(page.size)}</span></div></div></td><td class="mono">${esc(time || "-")}</td><td><span class="directory-cell" title="${esc(page.directoryName || "无目录")}">${esc(page.directoryName || "无目录")}</span></td><td class="mono">${Number(page.accessCount) || 0}</td><td>${deleted ? `<span class="pill ${page.visibility === "private" ? "warning" : "success"}">${accessLabel(page)}${page.hasAccessPassword ? " · 密码" : ""}</span>` : `<button class="pill visibility-toggle ${page.visibility === "private" ? "warning" : "success"}" type="button" data-action="visibility" data-id="${esc(page.id)}" title="设置文档访问权限">${accessLabel(page)}${page.hasAccessPassword ? " · 密码" : ""}</button>`}</td><td><span class="pill ${tone}">${state}</span></td><td><div class="row-actions">${deleted ? `<button class="btn" data-action="restore" data-id="${esc(page.id)}">恢复文档</button>` : `<button class="btn" data-action="preview" data-id="${esc(page.id)}">阅读</button>${editable ? `<a class="btn row-edit" href="${esc(page.editUrl)}" target="_blank" rel="noopener noreferrer">编辑</a>` : ""}<button class="btn icon-btn" data-action="more" data-id="${esc(page.id)}" aria-label="${esc(name)}的更多操作" aria-haspopup="menu">${icon("more")}</button>`}</div></td></tr>`;
    })
    .join("");
  for (const id of busyPages)
    document
      .querySelectorAll(`[data-id="${CSS.escape(id)}"]`)
      .forEach((el) => (el.disabled = true));
}
function renderList() {
  shell();
  syncFilters();
  renderStats();
  const trash = filters.scope === "trash";
  $("#listTitle").textContent = trash ? "回收站" : labels[filters.type];
  $("#listCount").textContent = `${pagination.total || 0} 个文档`;
  $("#paginationBar").innerHTML = paginationHtml(pagination);
  const empty = !pages.length;
  $("#managerTable").hidden = empty;
  $("#paginationBar").hidden = empty;
  $("#emptyState").hidden = !empty;
  if (empty) {
    const otherEmpty = filters.type === "other" && !(stats.byType?.other);
    const filtered = Boolean(
      filters.q ||
      filters.directory ||
      filters.directoryEmpty ||
      filters.visibility !== "all" ||
      (filters.accessMode && filters.accessMode !== "all") ||
      (filters.password && filters.password !== "all") ||
      filters.status !== "all" ||
      filters.type !== "all",
    );
    $("#emptyState").innerHTML =
      `<div class="empty-icon">${icon(trash ? "trash" : "document")}</div><h3>${otherEmpty ? "暂无其它文档" : filtered ? "没有匹配的文档" : trash ? "回收站为空" : "开始整理你的文档"}</h3><p>${otherEmpty ? "HTML、PDF、Word 以外的文档会归入此分类。" : filtered ? "调整关键词或筛选条件后再试。" : trash ? "移入回收站的文档会显示在这里，可随时恢复。" : "上传 HTML、PDF 或 Word，也可以导入整个目录。"}</p><div class="empty-actions">${filtered ? '<button class="btn" data-empty-clear>清除筛选</button>' : trash ? '<button class="btn" data-empty-active>返回文档列表</button>' : '<button class="btn primary" data-empty-upload>上传文件</button><button class="btn" id="addSample" data-empty-samples>添加示例</button>'}</div>`;
  }
  renderRows();
}
async function loadList() {
  if (!session) return;
  if (!isSettingsPage && filters.view === "analytics") return loadAnalytics();
  if (!isSettingsPage && filters.view === "analytics-details") return loadRankingDetails();
  const serial = ++requestSerial;
  $("#listLoading").hidden = false;
  $("#managerTable").setAttribute("aria-busy", "true");
  const p = queryString();
  p.delete("preview");
  p.delete("view");
  p.set("pageSize", "20");
  const now = new Date();
  p.set(
    "dayStart",
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
  );
  p.set(
    "dayEnd",
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).toISOString(),
  );
  try {
    const data = await api(`/api/pages?${p}`);
    if (serial !== requestSerial || !session) return;
    pages = data.pages || [];
    stats = data.stats || {};
    facets = data.facets || {};
    pagination = data.pagination;
    filters.page = pagination.page;
    writeUrl();
    $("#globalError").hidden = true;
    renderList();
  } catch (error) {
    if (serial === requestSerial) {
      showError(error);
      if (!pages.length) {
        $("#emptyState").hidden = false;
        $("#managerTable").hidden = true;
        $("#paginationBar").hidden = true;
        $("#emptyState").innerHTML =
          `<div class="empty-icon">${icon("refresh")}</div><h3>列表加载失败</h3><p>${esc(error.message)}</p><button class="btn" data-empty-retry>重试</button>`;
      }
    }
    throw error;
  } finally {
    if (serial === requestSerial) {
      $("#listLoading").hidden = true;
      $("#managerTable").removeAttribute("aria-busy");
    }
  }
}
function changeFilters(next, push = true) {
  clearTimeout(searchTimer);
  if (["upload", "analytics"].includes(next.view)) $("#searchInput").value = "";
  filters = {
    ...filters,
    view: "documents",
    q: $("#searchInput").value.trim(),
    ...next,
    page: 1,
    preview: "",
  };
  $("#mainContent").scrollTop = 0;
  hidePreview();
  writeUrl(push);
  loadList().catch(() => {});
}
function clearFilters() {
  clearTimeout(searchTimer);
  $("#searchInput").value = "";
  changeFilters({
    q: "",
    type: "all",
    status: "all",
    directory: "",
    directoryEmpty: false,
    visibility: "all",
    accessMode: "all",
    password: "all",
    sort: "updated_desc",
  });
}
function openEditor(page) {
  if (page?.canEdit && !page.deletedAt)
    window.open(
      page.editUrl || `${page.url}?edit=1`,
      "_blank",
      "noopener,noreferrer",
    );
}
async function copyPage(page) {
  try {
    await navigator.clipboard.writeText(
      new URL(page.url, location.origin).href,
    );
    toast(
      page.visibility === "private" ? "链接已复制，访问需要登录" : page.hasAccessPassword ? "链接已复制，请另行告知访问密码" : page.homepageListed === false ? "链接已复制，此文档仅链接可见" : "链接已复制",
    );
  } catch {
    toast("复制失败，请从文档信息中复制链接。", "error");
  }
}
async function downloadPage(page) {
  const epoch = sessionEpoch;
  try {
    const response = await fetch(apiUrl(`/api/pages/${encodeURIComponent(page.id)}/download`), {
      credentials: "same-origin",
    });
    if (!response.ok) {
      const data = await response.json();
      if (response.status === 401 && epoch === sessionEpoch)
        showLogin("登录已失效，请重新登录。");
      throw new Error(data.error || "下载失败，请稍后重试。");
    }
    const blob = await response.blob();
    if (epoch !== sessionEpoch || !session) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = page.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    if (epoch === sessionEpoch) toast(error.message || "下载失败，请稍后重试。", "error");
  }
}
function menuItems(page) {
  return [
    { label: "访问设置", icon: "lock", run: () => openAccess(page) },
    { label: "复制链接", icon: "copy", run: () => copyPage(page) },
    { label: "下载源文件", icon: "download", run: () => downloadPage(page) },
    {
      label: "新窗口打开",
      icon: "external",
      run: () => window.open(page.url, "_blank", "noopener,noreferrer"),
    },
    ...(page.canEdit
      ? [
          { label: "在线编辑", icon: "edit", run: () => openEditor(page) },
          { label: "版本记录", icon: "history", run: () => openHistory(page) },
        ]
      : []),
    ...(page.canSync
      ? [
          {
            label: "上传线上",
            icon: "upload",
            run: () => mutatePage(page, "sync"),
          },
        ]
      : []),
    {
      label: "移入回收站",
      icon: "trash",
      danger: true,
      run: () => mutatePage(page, "delete"),
    },
  ];
}
async function mutatePage(page, action) {
  if (action === "visibility") return openAccess(page);
  if (busyPages.has(page.id)) return;
  if (
    action === "delete" &&
    !(await confirmAction({
      title: "移入回收站",
      message: `“${page.title}”将暂时不可访问，可从回收站恢复。`,
      confirm: "移入回收站",
      danger: true,
    }))
  )
    return;
  if (action === "sync" && !settings.remoteSyncEnabled) {
    showError(new Error("请先在系统设置中启用线上绑定。"));
    return;
  }
  busyPages.add(page.id);
  renderRows();
  let result;
  try {
    result = await api(
      `/api/pages/${encodeURIComponent(page.id)}${action === "sync" ? "/sync" : action === "restore" ? "/restore" : ""}`,
      action === "visibility"
        ? json("PATCH", {
            visibility: page.visibility === "private" ? "public" : "private",
          })
        : { method: action === "delete" ? "DELETE" : "POST" },
    );
  } catch (error) {
    showError(error);
    return;
  } finally {
    busyPages.delete(page.id);
    renderRows();
  }
  toast(
    {
      delete: "已移入回收站",
      restore: "文档已恢复",
      sync: "已上传线上",
      visibility: "可见性已更新",
    }[action],
  );
  if (previewPage?.id === page.id && action === "delete") {
    filters.preview = "";
    hidePreview();
    writeUrl();
  } else if (previewPage?.id === page.id && result.page) {
    previewPage = result.page;
    renderPreviewMeta();
  }
  try {
    await loadList();
  } catch {
    notice(
      $("#globalError"),
      "操作已完成，列表刷新失败。请手动刷新。",
      "刷新列表",
    );
  }
}
async function addSamples(button) {
  if (!session || addingSamples) return;
  addingSamples = true;
  const buttons = new Set([
    ...document.querySelectorAll(
      "#uploadSamplesButton, #uploadMore, [data-empty-samples]",
    ),
    button,
  ]);
  for (const entry of buttons) {
    if (!entry) continue;
    entry.disabled = true;
    entry.setAttribute("aria-busy", "true");
  }
  try {
    const result = await api("/api/pages/samples", { method: "POST" });
    toast(`已添加 ${result.pages?.length || 0} 个示例`);
    filters.page = 1;
    try {
      await loadList();
    } catch {
      notice($("#globalError"), "示例已添加，列表刷新失败。", "刷新列表");
    }
  } catch (error) {
    showError(error);
  } finally {
    addingSamples = false;
    for (const entry of buttons) {
      if (!entry?.isConnected) continue;
      entry.disabled = false;
      entry.removeAttribute("aria-busy");
    }
  }
}
async function openPreview(id, push = true) {
  const serial = ++previewSerial;
  try {
    const page =
      pages.find((p) => p.id === id) ||
      (await api(`/api/pages/${encodeURIComponent(id)}`)).page;
    if (serial !== previewSerial || !session) return;
    if (page.deletedAt) throw new Error("文档已进入回收站，请先恢复。");
    if (push) {
      listScroll = $("#mainContent").scrollTop;
      listFocus = id;
      history.replaceState(
        { ...history.state, listScroll, focusId: id },
        "",
        location.href,
      );
      filters.view = "documents";
      filters.preview = id;
      writeUrl(true, { fromList: true, listScroll, focusId: id });
    }
    previewPage = page;
    shell();
    $("#managerView").hidden = true;
    $("#previewView").hidden = false;
    $("#mainContent").scrollTop = 0;
    $("#previewTitle").textContent = page.title;
    $("#previewTitle").title = page.title;
    $("#editFromPreview").hidden = !page.canEdit;
    $("#versionsTab").hidden = !page.canEdit;
    $("#previewInfo").hidden = true;
    $("#toggleInfo").setAttribute("aria-expanded", "false");
    $("#previewMeta").hidden = false;
    $("#previewVersions").hidden = true;
    $("#previewLoad").hidden = false;
    $("#previewLoad").textContent =
      "正在加载文档；如阅读区域未显示，可使用下方的新窗口入口。";
    $("#previewFrame").src = page.url;
    for (const id of ["openFromPreview", "readerOpen", "readerDownload"])
      $("#" + id).href = page.url;
    $("#readerDownload").hidden = page.fileType === "html";
    $("#readerTypeNote").textContent =
      page.fileType === "word"
        ? "Word 已转换为 PDF 阅读文件"
        : page.fileType === "pdf"
          ? "PDF 原生阅读"
          : "保留原始 HTML 排版";
    renderPreviewMeta();
    $("#closePreview").focus();
  } catch (error) {
    if (serial !== previewSerial || !session) return;
    filters.preview = "";
    writeUrl();
    hidePreview();
    showError(error);
  }
}
function hidePreview() {
  previewSerial++;
  historySerial++;
  previewPage = null;
  $("#previewView").hidden = true;
  shell();
  $("#previewFrame").removeAttribute("src");
  $("#previewInfo").hidden = true;
}
function closePreview() {
  if (history.state?.fromList) {
    history.back();
    return;
  }
  filters.preview = "";
  writeUrl();
  hidePreview();
  restoreListPosition();
}
function restoreListPosition() {
  const saved = history.state || {};
  $("#mainContent").scrollTop = saved.listScroll ?? listScroll;
  const id = saved.focusId || listFocus;
  const button = id
    ? document.querySelector(
        `[data-action="preview"][data-id="${CSS.escape(id)}"]`,
      )
    : null;
  button?.focus({ preventScroll: true });
}
function renderPreviewMeta() {
  if (!previewPage) return;
  const p = previewPage;
  const values = [
    ["文档 ID", p.id],
    ["文件类型", p.fileType === "word" ? "Word" : p.fileType.toUpperCase()],
    ["原文件名", p.fileName],
    ["目录", p.directoryName || "无目录"],
    ["大小", formatSize(p.size)],
    ["入库时间", formatDate(p.createdAt, true)],
    ["更新时间", formatDate(p.updatedAt, true)],
    ["访问次数", Number(p.accessCount) || 0],
    ["访问权限", accessLabel(p) + (p.hasAccessPassword ? " · 密码保护" : "")],
    [
      "源文件状态",
      p.status === "missing"
        ? "源文件缺失，生成文件可继续使用"
        : p.sourceType === "watch"
          ? "监听目录"
          : "文件上传",
    ],
    ...(p.sourcePath ? [["源文件路径", p.sourcePath]] : []),
    ["文档链接", new URL(p.url, location.origin).href],
  ];
  $("#previewMeta").innerHTML = values
    .map(
      ([label, value]) =>
        `<div><dt>${esc(label)}</dt><dd>${esc(value ?? "-")}</dd></div>`,
    )
    .join("");
}
async function renderVersions(page, target) {
  const serial = ++historySerial;
  target.innerHTML = '<p class="hint" role="status">正在加载版本记录…</p>';
  try {
    const data = await api(
      `/api/pages/${encodeURIComponent(page.id)}/versions`,
    );
    if (serial !== historySerial) return;
    target.innerHTML = data.versions.length
      ? data.versions
          .map(
            (v) =>
              `<article class="version-item"><strong>版本 ${Number(v.revision)} · ${esc(v.title)}</strong><p>${esc(formatDate(v.createdAt, true))} · ${esc(v.reason === "autosave" ? "自动保存" : v.reason === "manual" ? "手动保存" : v.reason.startsWith("restore-") ? "恢复前快照" : v.reason)}</p><button class="btn small" data-version="${esc(v.id)}" data-version-page="${esc(page.id)}" data-revision="${Number(v.revision)}">恢复此版本</button></article>`,
          )
          .join("")
      : '<div class="empty-state"><h3>暂无历史版本</h3><p>编辑保存后会自动保留先前内容的快照。</p></div>';
  } catch (error) {
    if (serial !== historySerial) return;
    target.innerHTML = `<div class="notice" role="alert">${esc(error.message)} <button class="btn small" data-versions-retry="${esc(page.id)}">重试</button></div>`;
  }
}
function openHistory(page) {
  historyPage = page;
  $("#historyTitle").textContent = `版本记录 · ${page.title}`;
  $("#historyDialog").showModal();
  renderVersions(page, $("#historyList"));
}
async function restoreVersion(button) {
  const inHistoryDialog = Boolean(button.closest("#historyList"));
  const target = inHistoryDialog ? $("#historyList") : $("#previewVersions");
  const epoch = sessionEpoch;
  const page =
    previewPage?.id === button.dataset.versionPage
      ? previewPage
      : historyPage || pages.find((p) => p.id === button.dataset.versionPage);
  if (!page || busyPages.has(page.id)) return;
  if (
    !(await confirmAction({
      title: "恢复版本",
      message: `将用版本 ${button.dataset.revision} 替换当前 HTML 内容。恢复前会保留当前内容的快照。`,
      confirm: "恢复版本",
    }))
  )
    return;
  busyPages.add(page.id);
  button.disabled = true;
  try {
    const data = await api(
      `/api/pages/${encodeURIComponent(page.id)}/restore/${encodeURIComponent(button.dataset.version)}`,
      { method: "POST" },
    );
    toast("版本已恢复");
    if (previewPage?.id === page.id) {
      previewPage = data.page;
      $("#previewFrame").src = page.url;
      renderPreviewMeta();
    }
    if (
      inHistoryDialog
        ? historyPage?.id === page.id && $("#historyDialog").open
        : previewPage?.id === page.id
    )
      await renderVersions(
        data.page,
        inHistoryDialog ? $("#historyList") : $("#previewVersions"),
      );
    try {
      await loadList();
    } catch {
      notice($("#globalError"), "版本已恢复，列表刷新失败。", "刷新列表");
    }
  } catch (error) {
    if (
      epoch !== sessionEpoch ||
      !session ||
      (inHistoryDialog
        ? historyPage?.id !== page.id || !$("#historyDialog").open
        : previewPage?.id !== page.id)
    )
      return;
    const errorBox = document.createElement("div");
    errorBox.className = "notice";
    errorBox.setAttribute("role", "alert");
    errorBox.textContent = error.message;
    target.prepend(errorBox);
  } finally {
    busyPages.delete(page.id);
    if (button.isConnected) button.disabled = false;
  }
}
function selectSettingsTab(id, { focus = false, historyMode } = {}) {
  const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')];
  const selected = tabs.find(tab => tab.getAttribute("aria-controls") === id) || tabs[0];
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
    $("#" + tab.getAttribute("aria-controls")).hidden = !active;
  }
  const hash = "#" + selected.getAttribute("aria-controls");
  if (historyMode && location.hash !== hash)
    history[historyMode + "State"](history.state, "", location.pathname + location.search + hash);
  const bar = selected.parentElement;
  const tabRect = selected.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  if (tabRect.left < barRect.left + 4) bar.scrollLeft -= barRect.left + 4 - tabRect.left;
  else if (tabRect.right > barRect.right - 4) bar.scrollLeft += tabRect.right - barRect.right + 4;
  if (focus) selected.focus({ preventScroll: true });
}
function revealSettingsError(field, message) {
  selectSettingsTab(field.closest('[role="tabpanel"]').id, { historyMode: "replace" });
  field.setAttribute("aria-invalid", "true");
  const hint = document.querySelector(`[data-error-for="${field.id}"]`);
  if (hint) {
    hint.textContent = message;
    hint.hidden = false;
  }
  field.focus();
}
function markSettingsDirty() {
  settingsDirty = true;
  settingsEditSerial++;
  updateSaveState();
}
function validPublicLink(value) {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value) || !(value.startsWith("/") && !value.startsWith("//") || /^https?:\/\//i.test(value))) return false;
  try {
    const parsed = new URL(value, location.origin);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function renderBrandPreview() {
  $("#brandPreviewTitle").textContent = $("#siteNameInput").value.trim() || "猎看文档系统";
  const caption = $("#publicBrandCaptionInput").value.trim();
  $("#brandPreviewCaption").textContent = caption;
  $("#brandPreviewCaption").hidden = !caption;
  const value = $("#publicLogoUrlInput").value.trim(), url = validPublicLink(value) ? value : "";
  const image = $("#brandPreviewImage");
  const sameUrl = image.getAttribute("src") === url;
  const showImage = !!url && !(sameUrl && image.complete && !image.naturalWidth);
  $("#brandPreviewSymbol").innerHTML = icon("document");
  $("#brandPreviewSymbol").hidden = showImage;
  $("#brandPreviewMark").classList.toggle("has-image", showImage);
  image.hidden = !showImage;
  if (url && !sameUrl) image.setAttribute("src", url);
  if (!url) image.removeAttribute("src");
}
async function uploadBrandLogo(file) {
  if (!file || logoUploading || !metadataReady) return;
  const epoch = sessionEpoch, serial = ++logoUploadSerial;
  logoUploading = true;
  updateSaveState();
  $("#brandLogoStatus").textContent = "正在上传 LOGO…";
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("LOGO 图片最大为 2 MiB");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("请上传 PNG、JPG 或 WebP 图片");
    if (typeof createImageBitmap === "function") {
      const image = await createImageBitmap(file);
      const tooLarge = image.width > 4096 || image.height > 4096;
      image.close();
      if (tooLarge) throw new Error("LOGO 图片宽高不能超过 4096 像素");
    }
    if (epoch !== sessionEpoch || serial !== logoUploadSerial || !session) return;
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/brand/logo", { method: "POST", body: form });
    if (epoch !== sessionEpoch || serial !== logoUploadSerial || !session) return;
    $("#publicLogoUrlInput").value = result.url;
    renderBrandPreview();
    markSettingsDirty();
    $("#brandLogoStatus").textContent = "LOGO 已上传，保存设置后在前台生效。";
  } catch (error) {
    if (epoch !== sessionEpoch || serial !== logoUploadSerial || !session) return;
    const message = error.name === "InvalidStateError" ? "图片无法读取，请选择完整的 PNG、JPG 或 WebP 图片。" : error.message;
    $("#brandLogoStatus").textContent = message;
    revealSettingsError($("#publicLogoUrlInput"), message);
  } finally {
    if (serial === logoUploadSerial) {
      logoUploading = false;
      updateSaveState();
    }
  }
}
function renderNavigationPreview() {
  $("#navigationPreviewBrand").textContent = $("#siteNameInput").value.trim() || "猎看文档系统";
  const host = $("#navigationPreviewLinks");
  host.replaceChildren();
  for (const item of navigationDraft.filter(item => item.enabled)) {
    const label = document.createElement("span");
    label.textContent = item.label.trim() || "未命名菜单";
    host.append(label);
  }
}
function renderNavigationEditor() {
  $("#navigationItems").innerHTML = navigationDraft.map((item, index) => {
    const builtin = item.id === "all-documents", id = esc(item.id);
    return `<li class="navigation-item" data-navigation-id="${id}">
      <div class="navigation-item-heading"><strong>菜单 ${index + 1}${builtin ? ' <span class="hint">内置入口</span>' : ""}</strong><div class="navigation-item-actions">
        <button class="btn small" type="button" data-navigation-action="up" aria-label="上移菜单 ${index + 1}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button class="btn small" type="button" data-navigation-action="down" aria-label="下移菜单 ${index + 1}" ${index === navigationDraft.length - 1 ? "disabled" : ""}>下移</button>
        ${builtin ? "" : '<button class="btn small danger" type="button" data-navigation-action="remove">删除</button>'}
      </div></div>
      <div class="navigation-item-fields">
        <label class="field"><span>菜单名称</span><input id="navigationLabel-${id}" data-navigation-field="label" value="${esc(item.label)}" maxlength="20" required ${builtin ? "disabled" : ""} /><small class="field-error" data-error-for="navigationLabel-${id}" hidden></small></label>
        <label class="field"><span>跳转地址</span><input id="navigationUrl-${id}" data-navigation-field="url" value="${esc(item.url)}" maxlength="2048" placeholder="/type/html 或 https://example.com" required ${builtin ? "disabled" : ""} /><small class="field-error" data-error-for="navigationUrl-${id}" hidden></small></label>
        <label class="field"><span>打开方式</span><select data-navigation-field="newTab" ${builtin ? "disabled" : ""}><option value="same" ${!item.newTab ? "selected" : ""}>当前页面</option><option value="new" ${item.newTab ? "selected" : ""}>新标签页</option></select></label>
        <label class="checkbox-field navigation-enabled"><input type="checkbox" data-navigation-field="enabled" ${item.enabled ? "checked" : ""} ${builtin ? "disabled" : ""} /><span>显示菜单</span></label>
      </div>
      ${builtin ? '<p class="hint">打开全部公开文档，清除当前关键词和分类条件。</p>' : '<label class="navigation-shortcut"><span>快捷地址</span><select data-navigation-preset aria-label="选择菜单快捷地址"><option value="">选择站内页面</option><option value="/">首页</option><option value="/type/html">HTML文档</option><option value="/type/pdf">PDF文档</option><option value="/type/word">Word文档</option></select></label>'}
    </li>`;
  }).join("");
  $("#navigationCount").textContent = `${navigationDraft.length} / 10`;
  $("#addNavigationItem").disabled = navigationDraft.length >= 10;
  renderNavigationPreview();
}
function validateNavigationDraft() {
  for (const item of navigationDraft) {
    if (!item.label.trim() || [...item.label.trim()].length > 20) {
      revealSettingsError($("#navigationLabel-" + item.id), "菜单名称需填写 1 至 20 个字符");
      return false;
    }
    const url = item.url.trim();
    if (!validPublicLink(url)) {
      revealSettingsError($("#navigationUrl-" + item.id), "菜单链接需填写站内路径或 HTTP/HTTPS 地址");
      return false;
    }
  }
  return true;
}
function updateSaveState() {
  $("#remoteSyncUrlInput").required = $("#remoteSyncEnabledInput").checked;
  $("#remoteSyncUrlInput").disabled = !$("#remoteSyncEnabledInput").checked;
  $("#currentPasswordInput").required =
    $("#adminPathInput").value.replace(/\/+$/, "") !== adminBase;
  const text = settingsSaving
    ? "保存中…"
    : settingsDirty
      ? "有未保存修改"
      : "已保存";
  $("#settingsSaveState").textContent = text;
  $("#settingsBottomState").textContent = text;
  $("#saveSettings").disabled = settingsSaving || logoUploading || !metadataReady;
  $("#saveSettingsTop").disabled = settingsSaving || logoUploading || !metadataReady;
  $("#uploadBrandLogo").disabled = logoUploading || !metadataReady;
  $("#resetBrandLogo").disabled = logoUploading || !metadataReady;
  $("#publicLogoUrlInput").disabled = logoUploading;
  $("#settingsForm").inert = !metadataReady;
}
const settingFields = {
  siteName: "siteNameInput",
  adminName: "adminNameInput",
  publicLogoUrl: "publicLogoUrlInput",
  publicBrandCaption: "publicBrandCaptionInput",
  publicSeoTitle: "publicSeoTitleInput",
  publicSeoDescription: "publicSeoDescriptionInput",
  publicSeoKeywords: "publicSeoKeywordsInput",
  trackingCode: "trackingCodeInput",
  remoteSyncUrl: "remoteSyncUrlInput",
  authUsername: "authUsernameInput",
  adminPath: "adminPathInput",
};
function fillSettings() {
  if (!settingsDirty) {
    for (const [key, id] of Object.entries(settingFields))
      $("#" + id).value = settings[key] ?? "";
    $("#publicHomepageEnabledInput").checked =
      settings.publicHomepageEnabled !== false;
    $("#remoteSyncEnabledInput").checked = Boolean(settings.remoteSyncEnabled);
    $("#publicBrandCaptionInput").value = settings.publicBrandCaption ?? "DOCUMENT WORKSPACE";
    navigationDraft = (settings.publicNavigation || [{ id: "all-documents", label: "全部文档", url: "/?view=resources", newTab: false, enabled: true }]).map(item => ({ ...item }));
    renderNavigationEditor();
    renderBrandPreview();
  }
  $("#remoteTokenState").textContent = settings.remoteSyncHasToken
    ? "已保存 Token，留空保持原值。"
    : "尚未保存 Token。";
  $("#outputDirValue").textContent = runtime.generatedDir || "无法读取运行目录";
  $("#sourceWriteDefault").textContent = runtime.configuredSourceWriteDefault
    ? "允许回写（实际以各目录状态为准）"
    : "只生成文档";
  $("#autosavePolicy").textContent =
    `编辑停止 ${runtime.autosaveDelayMs || 600}ms 后自动保存`;
  $("#snapshotPolicy").textContent = runtime.snapshotsEnabled
    ? "保存前自动保留内容快照"
    : "未启用";
  updateSaveState();
}
function renderWatchDirs() {
  const host = $("#watchList");
  host.innerHTML = watchDirs.length
    ? watchDirs
        .map(
          (item) =>
            `<article class="watch-item ${item.status === "error" ? "error" : ""}"><div class="watch-item-main"><strong class="watch-path">${esc(item.path)}</strong><div class="watch-meta"><span>${esc(item.name)}</span><span>${Number(item.htmlCount) || 0} 个 HTML</span><span>${item.allowWrite ? "允许源文件回写" : "只生成文档"}</span><span>${item.status === "error" ? "无法访问" : "自动监听"}</span></div>${item.error ? `<p class="watch-error">${esc(item.error)}</p>` : ""}</div><div class="watch-item-actions"><button class="btn small" type="button" data-watch-action="rescan" data-id="${esc(item.id)}">重新扫描</button><button class="btn small danger" type="button" data-watch-action="remove" data-id="${esc(item.id)}">移除</button></div></article>`,
        )
        .join("")
    : '<p class="hint">尚未添加监听目录。</p>';
}
async function reloadWatchDirs() {
  const epoch = sessionEpoch;
  const data = await api("/api/watch-dirs");
  if (epoch !== sessionEpoch || !session) return;
  watchDirs = data.watchDirs || [];
  renderWatchDirs();
  await loadList();
}
async function addWatchDir() {
  const input = $("#watchDirInput"),
    value = input.value.trim(),
    button = $("#addWatchDirectory");
  if (button.disabled) return;
  if (!value) {
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    await api(
      "/api/watch-dirs",
      json("POST", {
        path: value,
        name: value.split(/[\\/]/).filter(Boolean).at(-1),
        allowWrite: false,
      }),
    );
    if (input.value.trim() === value) input.value = "";
    toast("目录已添加并扫描");
    try {
      await reloadWatchDirs();
    } catch {
      showError(new Error("目录已添加，状态刷新失败，请重新打开设置。"));
    }
  } catch (error) {
    showError(error);
    input.focus();
  } finally {
    button.disabled = false;
  }
}
async function watchAction(button) {
  const action = button.dataset.watchAction;
  if (
    action === "remove" &&
    !(await confirmAction({
      title: "移除目录监听",
      message: "停止监听此目录，已生成的文档会保留。",
      confirm: "移除监听",
    }))
  )
    return;
  button.disabled = true;
  try {
    await api(
      `/api/watch-dirs/${encodeURIComponent(button.dataset.id)}${action === "rescan" ? "/rescan" : ""}`,
      { method: action === "rescan" ? "POST" : "DELETE" },
    );
    toast(action === "rescan" ? "目录已重新扫描" : "已移除监听");
    try {
      await reloadWatchDirs();
    } catch {
      showError(new Error("操作已完成，目录状态刷新失败。"));
    }
  } catch (error) {
    showError(error);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
async function saveSettings(event) {
  event.preventDefault();
  if (settingsSaving || logoUploading || !metadataReady) return;
  document
    .querySelectorAll("[data-error-for]")
    .forEach((el) => (el.hidden = true));
  document
    .querySelectorAll("[aria-invalid]")
    .forEach((el) => el.removeAttribute("aria-invalid"));
  updateSaveState();
  const form = $("#settingsForm");
  if (!validateNavigationDraft()) return;
  const logoUrl = $("#publicLogoUrlInput").value.trim();
  if (logoUrl && !validPublicLink(logoUrl)) {
    revealSettingsError($("#publicLogoUrlInput"), "LOGO 图片需填写站内路径或 HTTP/HTTPS 地址");
    return;
  }
  const invalid = [...form.querySelectorAll("input, select, textarea")]
    .find(field => field.willValidate && !field.validity.valid);
  if (invalid) {
    revealSettingsError(invalid, invalid.validationMessage);
    invalid.reportValidity();
    return;
  }
  if (!form.reportValidity()) return;
  const body = Object.fromEntries(
    Object.entries(settingFields).map(([key, id]) => [key, $("#" + id).value]),
  );
  Object.assign(body, {
    publicHomepageEnabled: $("#publicHomepageEnabledInput").checked,
    remoteSyncEnabled: $("#remoteSyncEnabledInput").checked,
    remoteSyncToken: $("#remoteSyncTokenInput").value,
    authPassword: $("#authPasswordInput").value,
    currentPassword: $("#currentPasswordInput").value,
    publicNavigation: navigationDraft.map(item => ({ ...item, label: item.label.trim(), url: item.url.trim() })),
  });
  settingsSaving = true;
  const submittedSerial = settingsEditSerial;
  updateSaveState();
  try {
    const data = await api("/api/settings", json("PATCH", body));
    const previous = adminBase;
    settings = data.settings;
    adminBase = settings.adminPath;
    settingsDirty = settingsEditSerial !== submittedSerial;
    for (const id of [
      "authPasswordInput",
      "currentPasswordInput",
      "remoteSyncTokenInput",
    ])
      if (
        $("#" + id).value ===
        body[
          {
            authPasswordInput: "authPassword",
            currentPasswordInput: "currentPassword",
            remoteSyncTokenInput: "remoteSyncToken",
          }[id]
        ]
      )
        $("#" + id).value = "";
    fillSettings();
    shell();
    toast("设置已保存");
    if (previous !== adminBase) location.assign(`${adminBase}/settings${location.hash}`);
  } catch (error) {
    const id = error.field || (/publicLogoUrl/.test(error.message) ? "publicLogoUrlInput" : /publicBrandCaption/.test(error.message) ? "publicBrandCaptionInput" : /publicNavigation|菜单/.test(error.message) ? "navigationSettings" : /密码/.test(error.message)
      ? "currentPasswordInput"
      : /目录|路径/.test(error.message)
        ? "adminPathInput"
        : /用户名/.test(error.message)
          ? "authUsernameInput"
          : /地址|URL/.test(error.message)
            ? "remoteSyncUrlInput"
            : null);
    if (id) {
      revealSettingsError($("#" + id), error.message);
    }
    showError(error);
  } finally {
    settingsSaving = false;
    updateSaveState();
  }
}
function uploadProgress(text, detail, badge, percent = null) {
  $("#uploadProgressText").textContent = text;
  $("#uploadProgressDetail").textContent = detail;
  $("#uploadProgressBadge").textContent = badge;
  $("#uploadProgressBar").classList.toggle("indeterminate", percent === null);
  $("#uploadProgressBar").style.width = `${percent ?? 100}%`;
  if (percent === null) $("#uploadProgress").removeAttribute("aria-valuenow");
  else $("#uploadProgress").setAttribute("aria-valuenow", String(percent));
}
function uploadStage(stage) {
  const done = stage === "done";
  const step = stage === "upload" ? 1 : done ? 3 : 2;
  const titles = { upload: "正在上传文档", review: "文件已上传，请核对信息", saving: "正在保存文档", done: "文档已入库" };
  const descriptions = {
    upload: "请保持当前页面打开。上传完成后，可在这里调整名称与访问权限。",
    review: "确认文档名称和访问方式，点击「确认入库」生成阅读链接。",
    saving: "正在生成阅读链接，Word 文档需要转换为 PDF，请稍候。",
    done: "本次上传已完成，你可以继续上传，或前往文档管理。",
  };
  $("#uploadTitle").textContent = titles[stage];
  $("#uploadDescription").textContent = descriptions[stage];
  $("#uploadWork").hidden = done;
  $("#uploadSuccess").hidden = !done;
  document.querySelectorAll("[data-upload-step]").forEach(el => {
    const number = Number(el.dataset.uploadStep);
    if (number === step) el.setAttribute("aria-current", "step");
    else el.removeAttribute("aria-current");
    el.classList.toggle("is-complete", number < step || done);
  });
}
function uploadLocks() {
  $("#uploadReviewRows").querySelectorAll("input,select,button").forEach(el => { el.disabled = committing || cancelling; });
  $("#uploadReviewRows").querySelectorAll("[data-upload-doc-id]").forEach(uploadPolicyState);
  for (const id of ["confirmUpload", "cancelUpload", "closeUpload"])
    $("#" + id).disabled =
      committing ||
      cancelling ||
      (id === "confirmUpload" && (!stagedUpload || uploadUnknown));
  $("#confirmUpload").textContent = committing ? "正在入库…" : stagedUpload?.documents?.length ? `确认入库（${stagedUpload.documents.length}）` : "确认入库";
  $("#confirmUpload").hidden = Boolean(completedUpload);
  $("#cancelUpload").hidden = Boolean(completedUpload);
  $("#cancelUpload").textContent = cancelling ? "正在清理…" : "取消上传";
  $("#closeUpload").setAttribute("aria-label", completedUpload ? "关闭上传结果" : "取消本次上传");
  $("#continueUpload").hidden = !completedUpload;
  $("#viewUploadedDocuments").hidden = !completedUpload;
  $("#verifyUpload").hidden = !uploadUnknown;
  $("#verifyUpload").disabled = committing || cancelling;
}
function resetUpload() {
  stagedUpload = null;
  completedUpload = null;
  uploadUnknown = false;
  uploadCancelled = false;
  $("#uploadReview").hidden = true;
  $("#uploadReviewRows").innerHTML = "";
  $("#uploadSuccessList").innerHTML = "";
  uploadStage("upload");
  $("#uploadFooterNote").textContent =
    "确认后才会加入文档列表；取消会清理本次上传。";
  uploadLocks();
}
function accessLabel(page) { return page.visibility === "private" ? "私有" : page.homepageListed === false ? "仅链接" : "公开"; }
const accessOptions = '<option value="public">公开 · 首页可见</option><option value="unlisted">公开 · 仅链接可见</option><option value="private">私有 · 管理员可见</option>';
function uploadPolicyState(row) {
  const mode = row.querySelector('[data-upload-field="visibility"]').value;
  const toggle = row.querySelector('[data-upload-field="protected"]');
  const password = row.querySelector('[data-upload-field="password"]');
  toggle.disabled = mode === "private" || committing || cancelling;
  row.querySelector('.upload-password-input').hidden = !toggle.checked;
  password.disabled = mode === "private" || !toggle.checked || committing || cancelling;
  row.querySelector('.upload-policy-hint').textContent = mode === "private" ? "私有文档通过管理员登录访问" : (mode === "unlisted" ? "仅获得链接的人可访问" : "此文档会出现在首页") + (toggle.checked ? "，打开文档需要验证密码" : "");
}
function renderUploadReview(upload) {
  uploadStage("review");
  $("#uploadReview").hidden = false;
  $("#uploadReviewCount").textContent = `${upload.documents.length} 个文档`;
  $("#uploadReviewSummary").textContent = upload.assetCount ? `包含 ${upload.assetCount} 个目录附件，将随文档一同保存。` : "已提取文档信息，可直接修改下方内容。";
  $("#uploadReviewRows").innerHTML = upload.documents.map(item => `<div class="upload-review-row" data-upload-doc-id="${esc(item.id)}"><div class="upload-review-type"><span class="pill">${esc(item.fileType.toUpperCase())}</span><span title="${esc(item.relativePath)}">${esc(item.directoryName || "无目录")}</span></div><label class="field"><span>文档标题</span><input data-upload-field="title" aria-label="文档标题" value="${esc(item.title)}"></label><label class="field"><span>文件名称</span><input data-upload-field="fileName" aria-label="文件名称" value="${esc(item.fileName)}" required></label><div class="upload-policy"><label class="field"><span>访问方式</span><select data-upload-field="visibility" aria-label="文档访问方式">${accessOptions}</select></label><div class="upload-password"><label class="checkbox-field"><input type="checkbox" data-upload-field="protected"><span>启用访问密码</span></label><div class="upload-password-input password-control" hidden><input type="password" data-upload-field="password" autocomplete="new-password" aria-label="访问密码" placeholder="设置访问密码，至少 6 个字符"><button type="button" class="btn" data-show-upload-password>显示</button></div></div><p class="hint upload-policy-hint"></p>${upload.documents.length > 1 ? `<button type="button" class="btn" data-apply-upload-policy>应用到本批 ${upload.documents.length} 个文档</button>` : ""}</div></div>`).join("");
  document.querySelectorAll('[data-upload-doc-id]').forEach((row,index) => { row.querySelector('[data-upload-field="visibility"]').value = upload.documents[index].visibility || "public"; uploadPolicyState(row); });
  uploadLocks();
}
function renderUploadSuccess(result) {
  completedUpload = result;
  stagedUpload = null;
  uploadUnknown = false;
  // Discard password drafts as soon as the upload is committed.
  $("#uploadReviewRows").innerHTML = "";
  const imported = result.pages || [];
  $("#uploadSuccessTitle").textContent = `已成功入库 ${imported.length} 个文档`;
  $("#uploadSuccessList").innerHTML = imported.map(page => `<li><div><strong>${esc(page.title || page.fileName)}</strong><span class="hint">${esc(page.fileName)} · ${esc(accessLabel(page))}${page.hasAccessPassword ? " · 需要密码" : ""}</span></div><a class="btn" href="${esc(page.url)}" target="_blank" rel="noopener" aria-label="在新标签页打开 ${esc(page.title || page.fileName)}">打开文档</a></li>`).join("");
  $("#uploadSuccessNote").textContent = "可前往文档管理复制链接、调整权限或更新内容。";
  $("#uploadFooterNote").textContent = "关闭弹窗后，仍可在文档管理中找到这些文档。";
  uploadStage("done");
  uploadLocks();
  $("#uploadTitle").focus({ preventScroll: true });
}
function uploadReviewDocuments() {
  return [...document.querySelectorAll("[data-upload-doc-id]")].map(row => {
    const mode = row.querySelector('[data-upload-field="visibility"]').value;
    const enabled = mode !== "private" && row.querySelector('[data-upload-field="protected"]').checked;
    const password = row.querySelector('[data-upload-field="password"]').value;
    return { id:row.dataset.uploadDocId, title:row.querySelector('[data-upload-field="title"]').value.trim(), fileName:row.querySelector('[data-upload-field="fileName"]').value.trim(), visibility: mode === "private" ? "private" : "public", homepageListed: mode !== "unlisted", passwordAction: enabled ? "set" : "keep", ...(enabled ? {password} : {}) };
  });
}
function uploadWithProgress(form) {
  const epoch = sessionEpoch;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUploadRequest = xhr;
    xhr.open("POST", apiUrl("/api/pages/upload/prepare"));
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) =>
      uploadProgress(
        "正在上传文件",
        event.lengthComputable
          ? `${formatSize(event.loaded)} / ${formatSize(event.total)}`
          : "正在传输文档与附件",
        event.lengthComputable
          ? `${Math.round((event.loaded / event.total) * 100)}%`
          : "上传中",
        event.lengthComputable
          ? Math.round((event.loaded / event.total) * 100)
          : null,
      );
    xhr.upload.onload = () =>
      uploadProgress(
        "正在解析文档",
        "文件已传输，正在提取标题和文件信息，即将进入核对步骤。",
        "解析中",
      );
    xhr.onload = () => {
      activeUploadRequest = null;
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("上传返回了无效结果，请刷新核对。"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401 && epoch === sessionEpoch) showLogin();
        reject(
          Object.assign(new Error(data.error || "上传失败"), {
            status: xhr.status,
          }),
        );
      }
    };
    xhr.onerror = () => {
      activeUploadRequest = null;
      reject(new Error("上传连接失败，请重新选择文件。"));
    };
    xhr.onabort = () => {
      activeUploadRequest = null;
      reject(new Error("上传已取消"));
    };
    xhr.send(form);
  });
}
async function uploadFiles(files) {
  if (!session) return;
  if (committing || cancelling || activeUploadRequest || stagedUpload) {
    if (!$("#uploadBackdrop").open) $("#uploadBackdrop").showModal();
    return;
  }
  const selected = [...files],
    directory = selected.some((file) => file.webkitRelativePath),
    pattern = /\.(html?|pdf|docx?)$/i;
  const uploadable = directory
    ? selected
    : selected.filter((file) => pattern.test(file.name));
  if (!uploadable.some((file) => pattern.test(file.name))) {
    toast("请选择 HTML、PDF 或 Word 文档。", "error");
    return;
  }
  if (uploadable.length > 200) {
    toast("每批最多 200 个文件，包含目录附件。", "error");
    return;
  }
  if (uploadable.some((file) => file.size > 20 * 1024 * 1024)) {
    toast("单文件最大 20 MiB，请调整后上传。", "error");
    return;
  }
  resetUpload();
  $("#uploadBackdrop").showModal();
  uploadProgress("正在准备上传", `共 ${uploadable.length} 个文件`, "准备", 0);
  const form = new FormData();
  for (const file of uploadable) {
    form.append("relativePath", file.webkitRelativePath || file.name);
    form.append("files", file, file.name);
  }
  try {
    const data = await uploadWithProgress(form);
    stagedUpload = data;
    if (uploadCancelled) {
      await cancelUpload();
      return;
    }
    uploadProgress(
      "文件已就绪，等待确认入库",
      "请逐项核对下方信息，确认前文档仅保存在暂存区。",
      "待确认",
      100,
    );
    renderUploadReview(data);
  } catch (error) {
    if (uploadCancelled) return;
    $("#uploadTitle").textContent = "上传未完成";
    $("#uploadDescription").textContent = "请查看下方原因，关闭弹窗后可重新选择文件。";
    uploadProgress("上传失败", error.message, "失败", 0);
    uploadLocks();
  }
}
async function cancelUpload() {
  if (committing || cancelling) return;
  cancelling = true;
  uploadLocks();
  uploadCancelled = true;
  if (activeUploadRequest) activeUploadRequest.abort();
  const batch = stagedUpload;
  try {
    if (batch?.uploadId) {
      try {
        await api(`/api/pages/upload/${encodeURIComponent(batch.uploadId)}`, {
          method: "DELETE",
        });
      } catch (error) {
        if (error.status !== 404) {
          uploadProgress(
            "暂存清理失败",
            error.message + "，请再次点击取消重试。",
            "待清理",
            0,
          );
          return;
        }
      }
    }
    if (stagedUpload === batch) {
      resetUpload();
      $("#uploadBackdrop").close();
    }
  } finally {
    cancelling = false;
    uploadLocks();
  }
}
async function confirmUpload() {
  if (committing || cancelling || !stagedUpload?.uploadId || uploadUnknown)
    return;
  const documents = uploadReviewDocuments();
  const invalidPolicy = documents.find(item => item.passwordAction === "set" && ([...item.password].length < 6 || [...item.password].length > 128 || !item.password.trim()));
  if (invalidPolicy) {
    const row = [...document.querySelectorAll('[data-upload-doc-id]')].find(el => el.dataset.uploadDocId === invalidPolicy.id);
    uploadProgress("请核对访问密码", "访问密码须为 6–128 个字符，且不能全部为空格。", "待修改",100);
    row.querySelector('[data-upload-field="password"]').focus(); return;
  }

  const invalid = [
    ...$("#uploadReviewRows").querySelectorAll("input[required]"),
  ].find((input) => !input.reportValidity());
  if (invalid) return;
  committing = true;
  uploadStage("saving");
  uploadLocks();
  uploadProgress(
    "正在生成文档",
    "正在保存文档并生成阅读链接，Word 文档需要转换为 PDF，请保持页面打开。",
    "处理中",
  );
  let result;
  try {
    result = await api(
      `/api/pages/upload/${encodeURIComponent(stagedUpload.uploadId)}/confirm`,
      json("POST", { documents }),
    );
  } catch (error) {
    uploadStage("review");
    uploadUnknown =
      !error.status || error.status >= 500 || error.status === 422;
    uploadProgress(
      uploadUnknown ? "入库结果需要核对" : "入库未完成",
      error.message +
        (uploadUnknown
          ? "。部分文档可能已入库，请先核对列表，再取消暂存并重选未入库文件。"
          : "。请核对列表中是否已有完成入库的文件。"),
      "请核对",
      0,
    );
    $("#uploadFooterNote").textContent =
      "请保留核对信息，核实列表后再处理；系统不会自动重放提交。";
    return;
  } finally {
    committing = false;
    uploadLocks();
  }
  renderUploadSuccess(result);
  try {
    await loadList();
  } catch {
    if (completedUpload === result)
      $("#uploadSuccessNote").textContent = "文档已成功入库。列表暂时刷新失败，可先打开文档，稍后前往文档管理刷新。";
    notice($("#globalError"), "文档已成功入库，列表刷新失败。", "刷新列表");
  }
}
$("#uploadReviewRows").onchange = event => { const row = event.target.closest('[data-upload-doc-id]'); if (row) uploadPolicyState(row); };
$("#uploadReviewRows").onclick = event => {
  if (committing || cancelling) return;
  const row = event.target.closest('[data-upload-doc-id]'); if (!row) return;
  if (event.target.closest('[data-show-upload-password]')) { const field = row.querySelector('[data-upload-field="password"]'); field.type = field.type === "password" ? "text" : "password"; event.target.textContent = field.type === "password" ? "显示" : "隐藏"; }
  if (event.target.closest('[data-apply-upload-policy]')) {
    for (const other of document.querySelectorAll('[data-upload-doc-id]')) {
      for (const key of ['visibility','password']) other.querySelector(`[data-upload-field="${key}"]`).value = row.querySelector(`[data-upload-field="${key}"]`).value;
      other.querySelector('[data-upload-field="protected"]').checked = row.querySelector('[data-upload-field="protected"]').checked;
      uploadPolicyState(other);
    }
    toast("访问设置已应用到本批文档");
  }
};
let accessPage = null, accessBusy = false, accessEpoch = 0;
function accessFormState() {
  const privateMode = $("#accessMode").value === "private";
  const action = $("#accessPasswordAction").value;
  $("#accessPasswordField").hidden = action !== "set";
  $("#accessPassword").required = action === "set" && !privateMode;
  $("#accessPasswordAction").disabled = privateMode || accessBusy;
  $("#accessPassword").disabled = privateMode || accessBusy;
  $("#accessModeHint").textContent = privateMode ? "私有文档通过管理员登录访问，原密码配置保留。" : $("#accessMode").value === "unlisted" ? "仅获得链接的人可访问，首页及搜索不会展示。可叠加密码保护。" : "文档会出现在公开首页，启用密码后访客需先验证。";
  $("#revokeAccess").disabled = accessBusy || !accessPage?.hasAccessPassword;
  for (const id of ['saveAccess','closeAccess','cancelAccess','accessMode','showAccessPassword']) $("#"+id).disabled = accessBusy;
}
function openAccess(page) {
  if (accessBusy) return;
  accessPage = page; accessEpoch = sessionEpoch;
  $("#accessDocumentName").textContent = page.title || page.fileName;
  $("#accessMode").value = page.visibility === "private" ? "private" : page.homepageListed === false ? "unlisted" : "listed";
  $("#accessPasswordAction").value = 'keep';
  $("#accessPasswordAction").options[0].textContent = page.hasAccessPassword ? "保留现有密码" : "保持无密码";
  $("#accessPassword").value = ''; $("#accessPassword").type = 'password'; $("#showAccessPassword").textContent = '显示'; $("#accessError").hidden = true;
  accessFormState(); $("#accessDialog").showModal();
}
function closeAccess() { if (accessBusy) return; $("#accessPassword").value = ''; $("#accessDialog").close(); accessPage = null; }
async function saveAccess(event) {
  event.preventDefault(); if (accessBusy || !accessPage) return;
  const target = accessPage, epoch = accessEpoch;
  const mode = $("#accessMode").value, action = mode === 'private' ? 'keep' : $("#accessPasswordAction").value;
  const password = $("#accessPassword").value;
  if (action === 'set' && ([...password].length < 6 || [...password].length > 128 || !password.trim())) { $("#accessError").textContent = '访问密码须为 6–128 个字符，且不能全部为空格'; $("#accessError").hidden = false; $("#accessPassword").focus(); return; }
  if (action === 'remove' && target.hasAccessPassword && !await confirmAction({title:'移除访问密码',message:'保存后，获得文档链接的人可直接阅读。是否继续？',confirm:'移除密码'})) return;
  if (target.visibility === 'private' && mode !== 'private' && !target.hasAccessPassword && action !== 'set' && !await confirmAction({title:'公开文档',message:'保存后，获得文档链接的人可直接阅读。是否继续？',confirm:'确认公开'})) return;
  if (epoch !== sessionEpoch || accessPage !== target) return;
  accessBusy = true; accessFormState(); $("#saveAccess").textContent = '保存中…'; $("#accessError").hidden = true;
  try {
    const result = await api(`/api/pages/${target.id}/access`,json('PATCH',{ visibility:mode === 'private' ? 'private' : 'public', homepageListed:mode === 'private' ? target.homepageListed !== false : mode === 'listed', passwordAction:action, ...(action === 'set' ? {password} : {}) }));
    if (epoch !== sessionEpoch) return;
    if (previewPage?.id === target.id) { previewPage = result.page; renderPreviewMeta(); }
    $("#accessPassword").value = ''; $("#accessDialog").close(); accessPage = null; toast('访问设置已保存');
    try { await loadList(); } catch { notice($("#globalError"),'访问设置已保存，列表刷新失败。','刷新列表'); }
  } catch(error) { if (epoch === sessionEpoch) { $("#accessError").textContent = error.message; $("#accessError").hidden = false; } }
  finally { accessBusy = false; $("#saveAccess").textContent = '保存设置'; accessFormState(); }
}
$("#accessForm").onsubmit = saveAccess;
$("#closeAccess").onclick = closeAccess; $("#cancelAccess").onclick = closeAccess;
$("#accessMode").onchange = accessFormState; $("#accessPasswordAction").onchange = accessFormState;
$("#showAccessPassword").onclick = event => { const input = $("#accessPassword"); input.type = input.type === 'password' ? 'text' : 'password'; event.target.textContent = input.type === 'password' ? '显示' : '隐藏'; };
$("#revokeAccess").onclick = async () => {
  if (accessBusy || !accessPage) return;
  const target = accessPage, epoch = sessionEpoch;
  if (!await confirmAction({title:'清除已记住的访问权限',message:'所有访客浏览器都需重新输入这份文档的密码，管理员阅读不受影响。',confirm:'清除权限'})) return;
  if (epoch !== sessionEpoch || accessPage !== target) return;
  accessBusy = true; accessFormState();
  try { await api(`/api/pages/${target.id}/access/revoke`,json('POST',{})); if (epoch === sessionEpoch) toast('已清除这份文档的浏览器访问权限'); }
  catch(error) { if (epoch === sessionEpoch) { $("#accessError").textContent = error.message; $("#accessError").hidden = false; } }
  finally { accessBusy = false; accessFormState(); }
};
wireDialog($("#accessDialog"),closeAccess,()=>accessBusy);
initShell("admin");
$("#previewFrame").addEventListener("load", () => {
  if (previewPage) {
    $("#previewLoad").textContent =
      "阅读文件已载入，若内容未显示请使用下方的新窗口阅读入口。";
  }
});
$("#previewFrame").addEventListener("error", () => {
  $("#previewLoad").textContent = "阅读资源加载失败，请使用下方入口重试。";
});
for (const id of ["pickFiles", "uploadFilesButton"])
  $("#" + id).onclick = () => $("#fileInput").click();
for (const id of ["pickDirectory", "uploadDirectoryButton"])
  $("#" + id).onclick = () => $("#directoryInput").click();
$("#uploadSamplesButton").onclick = (event) => addSamples(event.currentTarget);
for (const id of ["fileInput", "directoryInput"])
  $("#" + id).onchange = (event) => {
    uploadFiles(event.target.files);
    event.target.value = "";
  };
$("#uploadMore").onclick = (event) =>
  openMenu(event.currentTarget, [
    {
      label: "添加示例",
      icon: "document",
      run: () => addSamples($("#uploadMore")),
    },
    {
      label: "导入目录",
      icon: "folder",
      run: () => $("#directoryInput").click(),
    },
  ]);
$("#refreshList").onclick = async (event) => {
  event.currentTarget.disabled = true;
  try {
    await loadList();
    toast("列表已刷新");
  } catch {
  } finally {
    $("#refreshList").disabled = false;
  }
};
$("#globalError").onclick = (event) => {
  if (event.target.closest("[data-retry]"))
    (metadataReady ? loadList() : startAuthenticated()).catch(() => {});
};
$("#clearFilters").onclick = clearFilters;
$("#searchInput").oninput = () => {
  clearTimeout(searchTimer);
  const value = $("#searchInput").value.trim();
  searchTimer = setTimeout(() => changeFilters({ q: value }, false), 250);
};
for (const [id, key] of [
  ["statusSelect", "status"],
  ["passwordFilter", "password"],
  ["sortSelect", "sort"],
])
  $("#" + id).onchange = (event) =>
    changeFilters({ [key]: event.target.value });
$("#visibilitySelect").onchange = event => changeFilters({ accessMode: event.target.value === "public" ? "all" : event.target.value, visibility: event.target.value === "public" ? "public" : "all" });
$("#directorySelect").onchange = (event) =>
  changeFilters({
    directoryEmpty: event.target.value === "root",
    directory: event.target.value.startsWith("name:")
      ? event.target.value.slice(5)
      : "",
  });
document.querySelectorAll("[data-nav-type]").forEach((link) =>
  link.addEventListener("click", (event) => {
    if (
      isSettingsPage ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    const type = link.dataset.navType;
    changeFilters({
      ...(type === "upload" ? { q: "", visibility: "all", accessMode: "all", password: "all", sort: "updated_desc" } : {}),
      view: ["upload", "analytics"].includes(type) ? type : "documents",
      type: ["trash", "upload", "analytics"].includes(type) ? "all" : type,
      scope: type === "trash" ? "trash" : "active",
      status: "all",
      directory: "",
      directoryEmpty: false,
    });
  }),
);
$("#uploadListLink").onclick = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  clearFilters();
};
$("#refreshAnalytics").onclick = loadAnalytics;
$("#analyticsRange").onchange = () => {
  filters.analyticsDays = Number($("#analyticsRange").value);
  writeUrl(true);
  loadAnalytics();
};
$("#analyticsError").onclick = event => {
  if (event.target.closest("[data-retry]")) loadAnalytics();
};
$("#refreshRankingDetails").onclick = loadRankingDetails;
$("#rankingDetailsError").onclick = event => {
  if (event.target.closest("[data-retry]")) loadRankingDetails();
};
$("#rankingDetailsPager").addEventListener("click", async event => {
  const button = event.target.closest("[data-page]");
  if (!button || button.disabled) return;
  const ownsFocus = document.activeElement === button;
  const page = Number(button.dataset.page);
  filters.page = page;
  writeUrl(true);
  const pending = loadRankingDetails();
  const serial = requestSerial;
  const loaded = await pending;
  if (serial !== requestSerial || !session || $("#analyticsDetailsView").hidden) return;
  if (loaded) $("#mainContent").scrollTop = 0;
  if (!ownsFocus || document.activeElement !== document.body) return;
  if (loaded === false) $("#rankingDetailsError [data-retry]")?.focus();
  else if (loaded === true) {
    ($("#rankingDetailsPager").hidden ? $("#rankingDetailsTitle") : $("#rankingDetailsPager button[aria-current=page]") || $("#rankingDetailsTitle")).focus();
  }
});
const analyticsChartObserver = new ResizeObserver(() => {
  const chart = $("#analyticsChart");
  if (analyticsData && !$("#analyticsView").hidden && !$("#analyticsContent").hidden && chart.clientWidth > 0 && chart.clientWidth !== analyticsChartWidth) renderAnalyticsChart(analyticsData);
});
analyticsChartObserver.observe($("#analyticsChart"));
$("#paginationBar").onclick = (event) => {
  const button = event.target.closest("[data-page]");
  if (!button || button.disabled) return;
  filters.page = Number(button.dataset.page);
  writeUrl(true);
  loadList()
    .then(() => $("#dropZone").scrollIntoView({ block: "start" }))
    .catch(() => {});
};
$("#pageRows").onclick = (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const page = pages.find((p) => p.id === button.dataset.id);
  if (!page) return;
  if (button.dataset.action === "preview") openPreview(page.id);
  else if (button.dataset.action === "more") openMenu(button, menuItems(page));
  else mutatePage(page, button.dataset.action);
};
$("#emptyState").onclick = (event) => {
  if (event.target.closest("[data-empty-clear]")) clearFilters();
  if (event.target.closest("[data-empty-upload]")) $("#fileInput").click();
  if (event.target.closest("[data-empty-samples]")) addSamples(event.target);
  if (event.target.closest("[data-empty-active]"))
    changeFilters({ scope: "active" });
  if (event.target.closest("[data-empty-retry]")) loadList().catch(() => {});
};
$("#closePreview").onclick = closePreview;
$("#editFromPreview").onclick = () => openEditor(previewPage);
$("#copyFromPreview").onclick = () => copyPage(previewPage);
$("#previewMore").onclick = (event) =>
  openMenu(event.currentTarget, menuItems(previewPage));
$("#toggleInfo").onclick = () => {
  $("#previewInfo").hidden = !$("#previewInfo").hidden;
  $("#toggleInfo").setAttribute(
    "aria-expanded",
    String(!$("#previewInfo").hidden),
  );
};
$("#infoTab").onclick = () => {
  $("#previewMeta").hidden = false;
  $("#previewVersions").hidden = true;
};
$("#versionsTab").onclick = () => {
  $("#previewMeta").hidden = true;
  $("#previewVersions").hidden = false;
  renderVersions(previewPage, $("#previewVersions"));
};
$("#closeHistory").onclick = () => {
  $("#historyDialog").close();
  historySerial++;
};
wireDialog($("#historyDialog"), () => {
  $("#historyDialog").close();
  historySerial++;
});
document.addEventListener("click", (event) => {
  const restore = event.target.closest("[data-version]");
  if (restore) restoreVersion(restore);
  const retry = event.target.closest("[data-versions-retry]");
  if (retry) {
    const target = retry.closest("#historyList") || $("#previewVersions");
    renderVersions(
      previewPage?.id === retry.dataset.versionsRetry
        ? previewPage
        : historyPage,
      target,
    );
  }
});
$("#settingsForm").addEventListener("input", (event) => {
  if (["watchDirInput", "brandLogoFile"].includes(event.target.id)) return;
  const field = event.target.dataset.navigationField;
  if (field) {
    const item = navigationDraft.find(item => item.id === event.target.closest("[data-navigation-id]").dataset.navigationId);
    if (!item || item.id === "all-documents") return;
    item[field] = field === "enabled" ? event.target.checked : field === "newTab" ? event.target.value === "new" : event.target.value;
  }
  if (field || event.target.id === "siteNameInput") renderNavigationPreview();
  if (["siteNameInput", "publicLogoUrlInput", "publicBrandCaptionInput"].includes(event.target.id)) renderBrandPreview();
  markSettingsDirty();
});
$("#uploadBrandLogo").onclick = () => $("#brandLogoFile").click();
$("#brandLogoFile").onchange = event => {
  const file = event.target.files[0];
  event.target.value = "";
  return uploadBrandLogo(file);
};
$("#resetBrandLogo").onclick = () => {
  $("#publicLogoUrlInput").value = "";
  $("#publicLogoUrlInput").removeAttribute("aria-invalid");
  document.querySelector('[data-error-for="publicLogoUrlInput"]').hidden = true;
  $("#brandLogoStatus").textContent = "已恢复默认图标，保存设置后生效。";
  renderBrandPreview();
  markSettingsDirty();
};
$("#brandPreviewImage").onerror = () => {
  $("#brandPreviewImage").hidden = true;
  $("#brandPreviewSymbol").hidden = false;
  $("#brandPreviewMark").classList.remove("has-image");
};
$("#addNavigationItem").onclick = () => {
  if (!metadataReady || navigationDraft.length >= 10) return;
  const id = `menu-${Date.now().toString(36)}-${++navigationSerial}`;
  navigationDraft.push({ id, label: "", url: "", newTab: false, enabled: true });
  renderNavigationEditor();
  markSettingsDirty();
  $("#navigationLabel-" + id).focus();
  $("#navigationStatus").textContent = "已添加菜单，请填写名称和跳转地址。";
};
$("#navigationItems").onclick = event => {
  const button = event.target.closest("[data-navigation-action]");
  if (!button || button.disabled || !metadataReady) return;
  const row = button.closest("[data-navigation-id]");
  const index = navigationDraft.findIndex(item => item.id === row.dataset.navigationId);
  const item = navigationDraft[index], action = button.dataset.navigationAction;
  if (!item) return;
  const target = action === "up" ? index - 1 : index + 1;
  if (action === "remove") {
    if (item.id === "all-documents") return;
    navigationDraft.splice(index, 1);
  } else {
    if (target < 0 || target >= navigationDraft.length) return;
    [navigationDraft[index], navigationDraft[target]] = [navigationDraft[target], item];
  }
  renderNavigationEditor();
  markSettingsDirty();
  const nextRow = $("#navigationItems").children[action === "remove" ? Math.min(index, navigationDraft.length - 1) : target];
  (nextRow.querySelector(`[data-navigation-action="${action}"]:not(:disabled)`) || nextRow.querySelector("button:not(:disabled)") || $("#addNavigationItem")).focus();
  $("#navigationStatus").textContent = action === "remove" ? "菜单已删除，保存设置后生效。" : `${item.label || "未命名菜单"}已移至第 ${target + 1} 项。`;
};
$("#navigationItems").onchange = event => {
  if (!event.target.hasAttribute("data-navigation-preset") || !event.target.value) return;
  const row = event.target.closest("[data-navigation-id]");
  const item = navigationDraft.find(item => item.id === row.dataset.navigationId);
  item.url = event.target.value;
  if (!item.label.trim()) item.label = [...event.target.options].find(option => option.value === item.url).textContent;
  $("#navigationUrl-" + item.id).value = item.url;
  $("#navigationLabel-" + item.id).value = item.label;
  event.target.value = "";
  renderNavigationPreview();
  markSettingsDirty();
};
$("#settingsForm").onsubmit = saveSettings;
$(".settings-tabs").onclick = (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectSettingsTab(tab.getAttribute("aria-controls"), { historyMode: "push" });
};
$(".settings-tabs").onkeydown = (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')];
  const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  selectSettingsTab(tabs[index].getAttribute("aria-controls"), { focus: true, historyMode: "replace" });
};
window.addEventListener("hashchange", () => {
  if (isSettingsPage) selectSettingsTab(location.hash.slice(1));
});
$("#addWatchDirectory").onclick = addWatchDir;
$("#watchDirInput").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addWatchDir();
  }
};
$("#openSettingsSide").onclick = () => {
  selectSettingsTab("editSettings", { historyMode: "push" });
  $("#editSettings").setAttribute("tabindex", "-1");
  $("#editSettings").focus({ preventScroll: true });
};
$("#watchList").onclick = (event) => {
  const button = event.target.closest("[data-watch-action]");
  if (button && !button.disabled) watchAction(button);
};
window.addEventListener("beforeunload", (event) => {
  if (settingsDirty || committing) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("click", async (event) => {
  const link = event.target.closest("a[href]");
  if (
    !isSettingsPage ||
    !settingsDirty ||
    !link ||
    link.target === "_blank" ||
    link.getAttribute("href").startsWith("#")
  )
    return;
  event.preventDefault();
  if (
    await confirmAction({
      title: "离开设置",
      message: "当前设置有未保存修改，确认放弃后离开？",
      confirm: "放弃修改",
    })
  ) {
    settingsDirty = false;
    location.assign(link.href);
  }
});
$("#logoutButton").onclick = async () => {
  if (
    settingsDirty &&
    !(await confirmAction({
      title: "退出登录",
      message: "当前设置有未保存修改，退出后不会保存。",
      confirm: "退出登录",
    }))
  )
    return;
  try {
    await api("/api/logout", { method: "POST" });
    settingsDirty = false;
    hidePreview();
    $("#historyDialog").close();
    $("#uploadBackdrop").close();
    for (const id of [
      "authPasswordInput",
      "currentPasswordInput",
      "remoteSyncTokenInput",
    ])
      $("#" + id).value = "";
    showLogin();
  } catch (error) {
    showError(error);
  }
};
$("#loginForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#loginSubmit");
  button.disabled = true;
  button.textContent = "登录中…";
  $("#loginError").hidden = true;
  try {
    await api(
      "/api/login",
      json("POST", {
        username: $("#loginUsername").value.trim(),
        password: $("#loginPassword").value,
      }),
    );
    $("#loginPassword").value = "";
    await startAuthenticated();
  } catch (error) {
    $("#loginError").hidden = false;
    $("#loginError").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "登录工作台";
  }
};
$("#closeUpload").onclick = cancelUpload;
$("#cancelUpload").onclick = cancelUpload;
$("#confirmUpload").onclick = confirmUpload;
$("#continueUpload").onclick = () => {
  resetUpload();
  $("#uploadBackdrop").close();
  $("#fileInput").click();
};
$("#viewUploadedDocuments").onclick = () => {
  resetUpload();
  $("#uploadBackdrop").close();
  filters.scope = "active";
  clearFilters();
};
wireDialog($("#uploadBackdrop"), cancelUpload, () => committing || cancelling);
const verify = document.createElement("button");
verify.id = "verifyUpload";
verify.type = "button";
verify.className = "btn";
verify.textContent = "核对列表";
verify.hidden = true;
$("#confirmUpload").before(verify);
verify.onclick = async () => {
  if (verify.disabled || committing || cancelling || !session) return;
  const batch = stagedUpload;
  const epoch = sessionEpoch;
  const isCurrent = () =>
    stagedUpload === batch && epoch === sessionEpoch && session;
  verify.disabled = true;
  try {
    await loadList();
    if (!isCurrent()) return;
    filters.view = "documents";
    shell();
    writeUrl(true);
    $("#uploadBackdrop").close();
    toast("请核对列表，继续处理暂存批次时点击上传文件。", "info");
  } catch {
    if (!isCurrent()) return;
    uploadProgress(
      "列表核对失败",
      "网络恢复后再次核对，暂存输入会保留。",
      "待核对",
      0,
    );
  } finally {
    if (isCurrent()) uploadLocks();
  }
};
for (const drop of document.querySelectorAll("#dropZone, #uploadEntry")) {
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-dragging");
  });
  drop.addEventListener("dragleave", (event) => {
    if (!drop.contains(event.relatedTarget)) drop.classList.remove("is-dragging");
  });
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-dragging");
    uploadFiles(event.dataTransfer.files);
  });
}
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
window.addEventListener("popstate", async () => {
  if (isSettingsPage) {
    selectSettingsTab(location.hash.slice(1));
    return;
  }
  clearTimeout(searchTimer);
  filters = readFilters();
  $("#searchInput").value = filters.q;
  hidePreview();
  const serial = previewSerial;
  try {
    await loadList();
  } catch {}
  if (serial !== previewSerial || !session) return;
  if (["analytics", "analytics-details"].includes(filters.view)) return;
  if (filters.preview) await openPreview(filters.preview, false);
  else restoreListPosition();
});
async function startAuthenticated() {
  const epoch = ++sessionEpoch;
  uploadLocks();
  session = true;
  document.body.dataset.auth = "authenticated";
  $("#loginBackdrop").hidden = true;
  $("#bootScreen").hidden = true;
  updateSaveState();
  try {
    await loadMetadata();
    if (epoch !== sessionEpoch || !session) return;
    await loadList();
    if (epoch !== sessionEpoch || !session) return;
    if (filters.preview && !["analytics", "analytics-details"].includes(filters.view) && !isSettingsPage)
      await openPreview(filters.preview, false);
    if (epoch !== sessionEpoch || !session) return;
    if (stagedUpload && session) {
      uploadLocks();
      if (!uploadUnknown)
        uploadProgress(
          "登录已恢复",
          "核对信息已保留，可以继续确认入库或取消。",
          "待确认",
          100,
        );
      $("#uploadBackdrop").showModal();
    }
  } catch (error) {
    if (epoch === sessionEpoch && session) showError(error);
  }
}
(async () => {
  try {
    const data = await api("/api/session");
    settings = data.publicSettings || {};
    shell();
    if (data.authenticated) await startAuthenticated();
    else showLogin();
  } catch (error) {
    showLogin("连接失败，请稍后重新登录。");
  }
})();
