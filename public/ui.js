export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
const paths = {
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  document:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  upload: '<path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v7H4V6h7"/>',
  settings:
    '<path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  edit: '<path d="m16 3 5 5-13 13-5 1 1-5zM13 6l5 5"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  history: '<path d="M3 4v6h6M3 10a9 9 0 1 1 1 8"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
};
export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.document}</svg>`;
export function hydrateIcons(root = document) {
  root
    .querySelectorAll("[data-icon]")
    .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}
export const formatSize = (value) => {
  const n = Number(value) || 0;
  return n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
};
export function formatDate(value, full = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "-";
  const two = (number) => String(number).padStart(2, "0");
  return `${full ? date.getFullYear() + "/" : ""}${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
export const fileIcon = (type) =>
  `<span class="file-icon ${escapeHtml(type)}" aria-label="${escapeHtml(type === "word" ? "Word" : (type || "html").toUpperCase())}">${escapeHtml(type === "word" ? "DOC" : (type || "html").toUpperCase())}</span>`;
export function paginationHtml(p) {
  const page = Number(p.page) || 1,
    totalPages = Number(p.totalPages) || 1,
    total = Number(p.total) || 0;
  const numbers = [...new Set([1, totalPages, page - 1, page, page + 1])]
    .filter((n) => n > 0 && n <= totalPages)
    .sort((a, b) => a - b);
  let previous = 0;
  return `<span>共 ${total} 个文档${total ? ` · ${Number(p.offset || 0) + 1} 至 ${Math.min(Number(p.offset || 0) + Number(p.pageSize || 20), total)} 条` : ""}</span><div class="page-actions"><button class="btn" data-page="${page - 1}" ${p.hasPrev ? "" : "disabled"} aria-label="上一页">上一页</button>${numbers
    .map((n) => {
      const gap =
        previous && n - previous > 1 ? '<span aria-hidden="true">…</span>' : "";
      previous = n;
      return `${gap}<button class="btn" data-page="${n}" ${n === page ? 'aria-current="page"' : ""} aria-label="第 ${n} 页">${n}</button>`;
    })
    .join(
      "",
    )}<button class="btn" data-page="${page + 1}" ${p.hasNext ? "" : "disabled"} aria-label="下一页">下一页</button></div>`;
}
export function initShell(scope) {
  hydrateIcons();
  const sidebar = document.querySelector(".shell-sidebar"),
    workspace = document.querySelector(".shell-workspace"),
    toggle = document.querySelector("#sidebarToggle"),
    backdrop = document.querySelector("#sidebarBackdrop"),
    resizer = document.querySelector("#sidebarResizer");
  if (!sidebar || !toggle) return;
  const mobile = matchMedia("(max-width:800px)");
  let width = 228,
    collapsed = false,
    opened = false;
  try {
    width = Math.max(
      180,
      Math.min(
        320,
        Number(localStorage.getItem(`lkdoc-${scope}-width`)) || 228,
      ),
    );
    collapsed = sessionStorage.getItem(`lkdoc-${scope}-collapsed`) === "true";
  } catch {}
  function render() {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    document.body.classList.toggle(
      "sidebar-hidden",
      !mobile.matches && collapsed,
    );
    document.body.classList.toggle("drawer-open", mobile.matches && opened);
    sidebar.inert = mobile.matches ? !opened : collapsed;
    workspace.inert = mobile.matches && opened;
    backdrop.hidden = !(mobile.matches && opened);
    toggle.setAttribute(
      "aria-expanded",
      String(mobile.matches ? opened : !collapsed),
    );
    toggle.setAttribute(
      "aria-label",
      mobile.matches
        ? opened
          ? "关闭导航"
          : "展开导航"
        : collapsed
          ? "展开侧栏"
          : "收起侧栏",
    );
    resizer?.setAttribute("aria-valuenow", String(width));
  }
  function close() {
    opened = false;
    render();
    toggle.focus();
  }
  toggle.addEventListener("click", () => {
    if (mobile.matches) {
      opened = !opened;
      render();
      if (opened) sidebar.querySelector("a,button")?.focus();
    } else {
      collapsed = !collapsed;
      try {
        sessionStorage.setItem(`lkdoc-${scope}-collapsed`, String(collapsed));
      } catch {}
      render();
    }
  });
  backdrop.addEventListener("click", close);
  document.querySelector("#drawerClose")?.addEventListener("click", close);
  sidebar.addEventListener("click", (event) => {
    if (mobile.matches && event.target.closest(".nav-item")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (!mobile.matches || !opened) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") {
      const controls = [
        ...sidebar.querySelectorAll(
          'a[href],button:not(:disabled),[tabindex="0"]',
        ),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  mobile.addEventListener("change", () => {
    opened = false;
    render();
  });
  const setWidth = (value) => {
    width = Math.round(Math.max(180, Math.min(320, value)));
    render();
  };
  const remember = () => {
    try {
      localStorage.setItem(`lkdoc-${scope}-width`, String(width));
    } catch {}
  };
  resizer?.addEventListener("pointerdown", (event) => {
    if (mobile.matches) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    const start = event.clientX,
      initial = width;
    const move = (e) => setWidth(initial + e.clientX - start);
    const end = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
      remember();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  });
  resizer?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setWidth(
      event.key === "Home"
        ? 180
        : event.key === "End"
          ? 320
          : width + (event.key === "ArrowLeft" ? -10 : 10),
    );
    remember();
  });
  render();
}
let toastTimer;
export function toast(message, tone = "success") {
  const el = document.querySelector("#toast");
  if (!el) return;
  clearTimeout(toastTimer);
  el.dataset.tone = tone;
  el.setAttribute("role", tone === "error" ? "alert" : "status");
  el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
  el.hidden = false;
  toastTimer = setTimeout(
    () => (el.hidden = true),
    tone === "error" ? 6000 : 3000,
  );
}
export function wireDialog(dialog, close, locked = () => false) {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!locked()) close();
  });
  dialog.addEventListener("click", (event) => {
    const r = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom) &&
      !locked()
    )
      close();
  });
}
let activeConfirmation;
export function confirmAction({
  title,
  message,
  confirm = "确认",
  danger = false,
}) {
  const dialog = document.querySelector("#confirmDialog");
  if (dialog.open) return Promise.resolve(false);
  activeConfirmation?.(false);
  dialog.querySelector("h2").textContent = title;
  dialog.querySelector("p").textContent = message;
  const submit = dialog.querySelector("[data-confirm-submit]");
  submit.textContent = confirm;
  submit.className = `btn ${danger ? "danger" : "primary"}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("click", click);
      dialog.removeEventListener("close", closed);
      activeConfirmation = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const closed = () => {
      if (!dialog.open) finish(false);
    };
    const cancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const click = (event) => {
      if (event.target.closest("[data-confirm-submit]")) finish(true);
      else if (event.target.closest("[data-confirm-cancel]")) finish(false);
    };
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("click", click);
    dialog.addEventListener("close", closed);
    activeConfirmation = finish;
    dialog.showModal();
  });
}
export function openMenu(anchor, items) {
  let menu = document.querySelector("#actionMenu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "actionMenu";
    menu.className = "action-menu";
    menu.setAttribute("popover", "auto");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
  }
  menu.innerHTML = items
    .map(
      (item, i) =>
        `<button type="button" role="menuitem" data-menu-index="${i}" class="${item.danger ? "danger" : ""}" ${item.disabled ? "disabled" : ""}>${icon(item.icon || "document")}${escapeHtml(item.label)}</button>`,
    )
    .join("");
  menu.onclick = (event) => {
    const button = event.target.closest("[data-menu-index]");
    if (!button) return;
    menu.hidePopover();
    items[Number(button.dataset.menuIndex)].run();
  };
  menu.onkeydown = (event) => {
    const list = [...menu.querySelectorAll("button:not(:disabled)")],
      index = list.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      list[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? list.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) %
              list.length
      ]?.focus();
    }
  };
  menu.ontoggle = (event) => {
    if (
      event.newState === "closed" &&
      (document.activeElement === document.body ||
        menu.contains(document.activeElement)) &&
      anchor.isConnected
    )
      anchor.focus();
  };
  menu.showPopover();
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(innerWidth - menu.offsetWidth - 12, rect.right - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(12, Math.min(innerHeight - menu.offsetHeight - 12, rect.bottom + 6))}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}
export function notice(el, message, retryLabel = "重试") {
  el.hidden = false;
  el.innerHTML = `<span>${escapeHtml(message)}</span>${retryLabel ? ` <button class="btn small" data-retry>${escapeHtml(retryLabel)}</button>` : ""}`;
}
