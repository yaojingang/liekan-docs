import {
  escapeHtml as esc,
  icon,
  formatSize,
  paginationHtml,
  hydrateIcons,
} from "./ui.js?v=202610091";

const $ = (selector) => document.querySelector(selector);
const labels = {
  all: "全部文档",
  html: "HTML文档",
  pdf: "PDF文档",
  word: "Word文档",
};
const state = {
  ...readUrl(),
  pages: [],
  stats: null,
  pagination: null,
  phase: "loading",
};
const integer = new Intl.NumberFormat("zh-CN");
let serial = 0,
  timer;

function readUrl(url = location) {
  const params = new URLSearchParams(url.search);
  const match = url.pathname.match(/^\/type\/(html|pdf|word)\/?$/i);
  const page = Number(params.get("page"));
  return {
    view: match || params.get("view") === "resources" || ["q", "sort", "page"].some(key => params.has(key)) ? "resources" : "home",
    type: match ? match[1].toLowerCase() : "all",
    q: (params.get("q") || "").trim(),
    sort:
      params.get("sort") === "created_desc" ? "created_desc" : "updated_desc",
    page: Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1,
  };
}
function urlFor(value) {
  if (value.view === "home") return "/";
  const params = new URLSearchParams();
  if (value.q) params.set("q", value.q);
  if (value.sort !== "updated_desc") params.set("sort", value.sort);
  if (value.page > 1) params.set("page", String(value.page));
  const path = value.type === "all" ? "/" : `/type/${value.type}`;
  if (value.type === "all") params.set("view", "resources");
  return `${path}${params.size ? "?" + params : ""}`;
}
function updateUrl(push) {
  const url = urlFor(state);
  if (url !== location.pathname + location.search)
    history[push ? "pushState" : "replaceState"]({}, "", url);
}
function cancelSearch() {
  clearTimeout(timer);
  timer = undefined;
}
function searchValue() {
  return $(state.view === "home" ? "#homeSearchInput" : "#searchInput").value.trim();
}
function metricCount(count) {
  const divisor = count >= 100000000 ? 100000000 : count >= 10000 ? 10000 : 1;
  return divisor === 1
    ? integer.format(count)
    : `${Math.floor((count / divisor) * 10) / 10}${divisor === 10000 ? "万" : "亿"}`;
}
function renderNavigation() {
  document
    .querySelectorAll("#statsLine [data-type]")
    .forEach((link) => {
      const type = link.dataset.type;
      const selected = state.view === "resources" && type === state.type;
      link.classList.toggle("is-active", selected);
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      link.setAttribute(
        "href",
        urlFor({ ...state, view: "resources", type, q: searchValue(), page: 1 }),
      );
      const known = state.stats !== null;
      const count = known ? Number(state.stats[type]) || 0 : null;
      const card = link.classList.contains("stat-card");
      link.querySelector("[data-count]").textContent = known
        ? card
          ? metricCount(count)
          : integer.format(count)
        : "--";
      link.setAttribute(
        "aria-label",
        `${labels[type]}，${known ? integer.format(count) + " 个公开资源" : state.phase === "error" ? "数量暂不可用" : "数量加载中"}`,
      );
      if (card)
        link.querySelector("small").textContent = known
          ? `${integer.format(count)} 个公开资源`
          : state.phase === "error"
            ? "数量暂不可用"
            : "数量加载中";
    });
  $("#statsNote").textContent =
    state.phase === "error" && state.stats
      ? "统计范围：全部公开文档 · 统计为上次成功加载结果"
      : "统计范围：全部公开文档";
  document.querySelectorAll(".public-menu-link").forEach(link => {
    const url = new URL(link.getAttribute("href"), location.href);
    const active = link.id === "allDocumentsLink"
      ? state.view === "resources" && state.type === "all"
      : url.origin === location.origin && (url.pathname === "/" || /^\/type\/(html|pdf|word)\/?$/i.test(url.pathname)) && urlFor(readUrl(url)) === urlFor(state);
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}
function renderControls() {
  const home = state.view === "home";
  $("#homeHero").hidden = !home;
  $("#homeGuide").hidden = !home;
  $("#homeViewAll").hidden = !home;
  $("#listIntro").hidden = home;
  $("#listCaption").hidden = home;
  $("#publicListToolbar").hidden = home;
  $("#publicHomeLink").classList.toggle("is-active", home);
  if (home) $("#publicHomeLink").setAttribute("aria-current", "page");
  else $("#publicHomeLink").removeAttribute("aria-current");
  $("#publicListHint").hidden = home;
  $("#publicListHint").textContent = "每页 10 条 · 点击文档行打开";
  $("#sortSelect").value = state.sort;
  $("#publicListTitle").textContent = home ? "最近更新" : labels[state.type];
  renderNavigation();
}
function renderEmpty() {
  const emptyLibrary = state.stats.all === 0;
  const emptyCategory = !emptyLibrary && !state.q && state.type !== "all";
  const title = emptyLibrary
    ? "暂无公开资源"
    : emptyCategory
      ? `暂无 ${labels[state.type]}`
      : "没有匹配的资源";
  const message = emptyLibrary
    ? "发布后的公开资源会显示在这里。"
    : emptyCategory
      ? "可以查看其他类型的公开资源。"
      : "调整关键词或资源类型后再试。";
  $("#emptyState").innerHTML =
    `<div class="empty-icon">${icon("document")}</div><h3>${title}</h3><p>${message}</p>${emptyLibrary ? "" : emptyCategory ? '<button class="btn" data-all>查看全部资源</button>' : '<button class="btn" data-clear>清除筛选</button>'}`;
  $("#emptyState").hidden = false;
  $("#resultStatus").textContent = title;
}
function renderResults() {
  renderControls();
  $("#docRows").innerHTML = state.pages
    .map((page) => {
      const name = page.title || page.fileName || page.slug;
      const url = page.url || `/${page.slug}`;
      const date = page.updatedDate || "-";
      const type =
        page.fileType === "word"
          ? "Word"
          : page.fileType === "pdf"
            ? "PDF"
            : "HTML";
      const openLabel = esc(`${name}${page.hasAccessPassword ? "，需要访问密码" : ""}，在新标签页打开`);
      return `<tr class="resource-row">
      <td class="title-cell"><a class="doc-name resource-row-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${openLabel}"><span class="resource-icon" aria-hidden="true">${icon("document")}</span><span class="title-copy">
        <span class="title-main" title="${esc(name)}">${esc(name)}${page.hasAccessPassword ? `<span class="resource-lock" title="需要访问密码">${icon("lock")}<span class="sr-only">需要访问密码</span></span>` : ""}</span>
        <span class="title-meta"><span class="resource-file-name" title="${esc(page.fileName)}">${esc(page.fileName)}</span><span class="resource-size">${formatSize(page.size)}</span></span>
      </span></a></td>
      <td class="time-column resource-time mono">${esc(date)}</td>
      <td class="type-column"><span class="resource-type">${type}</span></td>
      <td class="open-column"><a class="btn small resource-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${openLabel}">打开 ${icon("external")}</a></td>
    </tr>`;
    })
    .join("");
  $("#publicListCount").textContent = state.view === "home"
    ? `最近 ${state.pages.length} 份`
    : `当前结果 ${integer.format(state.pagination.total)} 条`;
  const empty = state.pages.length === 0;
  $("#publicTable").hidden = empty;
  $("#pagination").hidden = empty || state.view === "home";
  $("#emptyState").hidden = !empty;
  $("#pagination").innerHTML = empty || state.view === "home" ? "" : paginationHtml(state.pagination);
  if (empty) renderEmpty();
  else
    $("#resultStatus").textContent =
      state.view === "home" ? `最近更新，展示 ${state.pages.length} 份公开文档` : `${labels[state.type]}，共 ${integer.format(state.pagination.total)} 条，第 ${state.page} 页`;
}
async function load(push = false) {
  const current = ++serial;
  const focusOrigin = document.activeElement?.closest(
    "#pagination button, #emptyState button, #homeSearch input, #homeSearch button",
  );
  const pageAction = focusOrigin?.closest("#pagination")
    ? focusOrigin.getAttribute("aria-label")
    : null;
  const heading = $("#publicListTitle");
  state.phase = "loading";
  updateUrl(push);
  renderControls();
  if (focusOrigin) heading.focus({ preventScroll: true });
  $("#publicLoading").hidden = false;
  $("#publicTable").hidden = true;
  $("#pagination").hidden = true;
  $("#emptyState").hidden = true;
  $("#publicListCount").textContent = "正在加载…";
  $(".resource-panel").setAttribute("aria-busy", "true");
  $("#resultStatus").textContent = state.view === "home" ? "正在加载最近更新文档" : `正在加载${labels[state.type]}`;
  const params = new URLSearchParams({
    type: state.type,
    q: state.q,
    sort: state.sort,
    page: String(state.page),
    pageSize: state.view === "home" ? "6" : "10",
  });
  try {
    const response = await fetch(`/public/api/pages?${params}`, {
      credentials: "same-origin",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "资源列表暂不可用");
    if (current !== serial) return;
    state.pages = data.pages;
    state.stats = data.stats;
    state.pagination = data.pagination;
    state.page = data.pagination.page;
    state.phase = "ready";
    updateUrl(false);
    renderResults();
  } catch (error) {
    if (current !== serial) return;
    state.phase = "error";
    renderControls();
    $("#publicListCount").textContent = "结果暂不可用";
    $("#emptyState").hidden = false;
    $("#emptyState").innerHTML =
      `<div class="empty-icon">${icon("refresh")}</div><h3>资源加载失败</h3><p>资源列表暂时无法加载，请稍后重试。</p><button class="btn" data-retry>重试</button>`;
    $("#resultStatus").textContent = "资源加载失败，可以重试";
  } finally {
    if (current === serial) {
      $("#publicLoading").hidden = true;
      $(".resource-panel").removeAttribute("aria-busy");
      if (focusOrigin && document.activeElement === heading) {
        let target = $("#emptyState button") || heading;
        if (!$("#publicTable").hidden) {
          target =
            (pageAction &&
              [...document.querySelectorAll("#pagination button")].find(
                (button) =>
                  !button.disabled &&
                  button.getAttribute("aria-label") === pageAction,
              )) ||
            (pageAction && $("#pagination [aria-current='page']")) ||
            $("#publicTable");
        }
        target.focus({ preventScroll: true });
      }
    }
  }
}
function clear() {
  cancelSearch();
  $("#searchInput").value = "";
  Object.assign(state, { view: "resources", q: "", type: "all", sort: "updated_desc", page: 1 });
  return load(true);
}
function selectCategory(type) {
  cancelSearch();
  Object.assign(state, { view: "resources", q: searchValue(), type, page: 1 });
  $("#searchInput").value = state.q;
  $("#mainContent").scrollTop = 0;
  return load(true);
}
function onCategoryClick(event) {
  const link = event.target.closest("[data-type]");
  if (
    !link ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
    return;
  event.preventDefault();
  return link.id === "homeViewAll" ? clear() : selectCategory(link.dataset.type);
}

hydrateIcons();
const logoImage = $("#publicLogoImage");
if (logoImage) {
  const showDefaultLogo = () => {
    logoImage.hidden = true;
    logoImage.parentElement.classList.remove("has-image");
    logoImage.parentElement.querySelector(".brand-symbol").hidden = false;
  };
  logoImage.addEventListener("error", showDefaultLogo);
  if (logoImage.complete && !logoImage.naturalWidth) showDefaultLogo();
}
const navigation = $("#publicNavigation");
const navigationLinks = [...navigation.querySelectorAll(".public-menu-link")];
function fitNavigation() {
  if (!navigation.clientWidth) return;
  const main = $("#publicNavLinks"), more = $("#publicNavMore"), overflow = $("#publicNavOverflow");
  const focused = document.activeElement;
  for (const link of navigationLinks) main.append(link);
  more.hidden = true;
  const compact = window.innerWidth <= 800;
  if (main.scrollWidth <= navigation.clientWidth && !compact) {
    more.open = false;
  } else if (navigationLinks.length > 1) {
    more.hidden = false;
    const widths = new Map(navigationLinks.map(link => [link, link.getBoundingClientRect().width + 4]));
    const all = $("#allDocumentsLink");
    let available = navigation.clientWidth - more.getBoundingClientRect().width - 8 - widths.get(all);
    let overflowed = compact;
    for (const link of navigationLinks) {
      if (link === all) continue;
      if (overflowed || widths.get(link) > available) {
        overflowed = true;
        overflow.append(link);
      } else available -= widths.get(link);
    }
  }
  if (focused?.classList.contains("public-menu-link")) {
    if (overflow.contains(focused) && !more.open) more.querySelector("summary").focus({ preventScroll: true });
    else focused.focus({ preventScroll: true });
  } else if (more.contains(focused)) {
    (more.hidden ? $("#allDocumentsLink") : focused).focus({ preventScroll: true });
  }
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(fitNavigation).observe(navigation);
window.addEventListener("resize", fitNavigation);
fitNavigation();
document.addEventListener("click", event => {
  const more = $("#publicNavMore");
  if (!more.contains(event.target)) more.open = false;
});
$("#publicNavMore").onkeydown = event => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  $("#publicNavMore").open = false;
  $("#publicNavMore summary").focus();
};
$("#searchInput").value = state.q;
$("#publicHomeLink").onclick = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  cancelSearch();
  Object.assign(state, { view: "home", type: "all", q: "", sort: "updated_desc", page: 1 });
  $("#homeSearchInput").value = "";
  $("#searchInput").value = "";
  $("#mainContent").scrollTop = 0;
  return load(true);
};
$("#allDocumentsLink").onclick = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  $("#mainContent").scrollTop = 0;
  return clear();
};
$("#homeViewAll").onclick = onCategoryClick;
$("#homeSearchInput").oninput = renderNavigation;
$("#homeSearch").onsubmit = (event) => {
  event.preventDefault();
  cancelSearch();
  Object.assign(state, { view: "resources", type: "all", q: $("#homeSearchInput").value.trim(), sort: "updated_desc", page: 1 });
  $("#searchInput").value = state.q;
  $("#mainContent").scrollTop = 0;
  return load(true);
};
$("#statsLine").onclick = onCategoryClick;
$("#searchInput").oninput = () => {
  cancelSearch();
  renderNavigation();
  timer = setTimeout(() => {
    timer = undefined;
    state.q = searchValue();
    state.page = 1;
    load();
  }, 250);
};
$("#sortSelect").onchange = (event) => {
  cancelSearch();
  Object.assign(state, { q: searchValue(), sort: event.target.value, page: 1 });
  return load(true);
};
$("#clearFilters").onclick = clear;
$("#emptyState").onclick = (event) => {
  if (event.target.closest("[data-clear]")) return clear();
  if (event.target.closest("[data-all]")) return selectCategory("all");
  if (event.target.closest("[data-retry]")) {
    cancelSearch();
    if (state.view !== "home" && state.q !== searchValue()) {
      state.q = searchValue();
      state.page = 1;
    }
    return load();
  }
};
$("#pagination").onclick = (event) => {
  const button = event.target.closest("[data-page]");
  if (!button || button.disabled) return;
  cancelSearch();
  const q = searchValue();
  state.page = q !== state.q ? 1 : Number(button.dataset.page);
  state.q = q;
  $(".resource-panel").scrollIntoView({ block: "start" });
  return load(true);
};
window.addEventListener("popstate", () => {
  cancelSearch();
  Object.assign(state, readUrl());
  $("#searchInput").value = state.q;
  $("#homeSearchInput").value = state.q;
  return load();
});
load();
