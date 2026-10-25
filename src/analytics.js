const dayMs = 86400000;
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

// Find the first instant in a calendar day, including DST days with no midnight.
function startOfDay(key, formatter) {
  const midnight = Date.parse(`${key}T00:00:00Z`);
  let low = midnight - 36 * 3600000, high = midnight + 36 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    if (formatter.format(new Date(middle)) < key) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}

export function analyticsWindow(query = {}, now = new Date()) {
  const days = Number(query.days ?? 30);
  if (![7, 30, 90].includes(days)) throw invalid("请选择近 7、30 或 90 天");
  const timeZone = query.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let formatter;
  try {
    if (typeof timeZone !== "string" || timeZone.length > 100) throw new Error();
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw invalid("统计时区无效");
  }
  const today = formatter.format(now);
  const calendar = Date.parse(`${today}T00:00:00Z`);
  const keys = Array.from({ length: days + 1 }, (_, i) => new Date(calendar + (i - days + 1) * dayMs).toISOString().slice(0, 10));
  const boundaries = keys.map(key => startOfDay(key, formatter));
  return {
    days, timeZone, today,
    start: boundaries[0], end: boundaries.at(-1),
    todayStart: boundaries.at(-2),
    yesterdayStart: boundaries.at(-3),
    buckets: keys.slice(0, -1).map((date, i) => ({ date, start: boundaries[i], end: boundaries[i + 1] })),
  };
}

export class PageAnalytics {
  constructor(db) { this.db = db; }

  summary(start, end) {
    return {
      todayViews: this.db.prepare("SELECT COUNT(*) AS count FROM page_views WHERE viewed_at >= ? AND viewed_at < ?").get(start, end).count,
      totalViews: this.db.prepare("SELECT COALESCE(SUM(access_count), 0) AS count FROM pages").get().count,
    };
  }

  record(id, at = new Date().toISOString()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE pages SET access_count = access_count + 1 WHERE id = ? AND deleted_at IS NULL").run(id);
      if (result.changes) this.db.prepare("INSERT INTO page_views (page_id, viewed_at) VALUES (?, ?)").run(id, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ranking(mode, start, end, requestedPage = 1, pageSize = 10) {
    const number = Number(requestedPage);
    if (!Number.isSafeInteger(number) || number < 1) throw invalid("排行榜页码须为正整数");
    const source = mode === "today"
      ? "(SELECT page_id, COUNT(*) AS views FROM page_views WHERE viewed_at >= ? AND viewed_at < ? GROUP BY page_id) v JOIN pages p ON p.id = v.page_id"
      : "pages p";
    const count = mode === "today" ? "v.views" : "p.access_count";
    const params = mode === "today" ? [start, end] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM ${source} WHERE ${count} > 0`).get(...params).count;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(number, totalPages);
    const offset = (page - 1) * pageSize;
    const rows = this.db.prepare(`SELECT p.id, p.slug, p.title, p.file_name, p.file_type, p.deleted_at, ${count} AS views
      FROM ${source} WHERE ${count} > 0 ORDER BY views DESC, p.title COLLATE NOCASE, p.id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return {
      pages: rows.map((row, i) => ({
        id: row.id, title: row.title || row.file_name, fileType: row.file_type || "html",
        url: `/${row.slug}`, deleted: Boolean(row.deleted_at), views: row.views, rank: offset + i + 1,
      })),
      pagination: { page, pageSize, total, totalPages, offset, hasPrev: page > 1, hasNext: page < totalPages },
    };
  }

  rankingDetails(query = {}, now = new Date()) {
    const mode = query.mode;
    if (!["total", "today"].includes(mode)) throw invalid("请选择累计或今日浏览明细");
    const window = analyticsWindow({ days: 7, timeZone: query.timeZone }, now);
    const summary = this.summary(window.todayStart, window.end);
    return {
      mode, timeZone: window.timeZone, today: window.today, generatedAt: now.toISOString(),
      views: mode === "total" ? summary.totalViews : summary.todayViews,
      ...this.ranking(mode, window.todayStart, window.end, query.page ?? 1, 20),
    };
  }

  report(query = {}, now = new Date()) {
    const window = analyticsWindow(query, now);
    const { start, end, todayStart, yesterdayStart } = window;
    const trackingStartedAt = this.db.prepare("SELECT value FROM settings WHERE key = 'analytics_started_at'").get().value;
    const daily = this.db.prepare("SELECT COUNT(*) AS views, COUNT(DISTINCT page_id) AS documents FROM page_views WHERE viewed_at >= ? AND viewed_at < ?");
    const trend = window.buckets.map(bucket => ({ date: bucket.date, ...(bucket.end > trackingStartedAt ? daily.get(bucket.start, bucket.end) : { views: null, documents: null }) }));
    const trackedDays = trend.filter(day => day.views !== null).length;
    const period = this.db.prepare("SELECT COUNT(*) AS views, COUNT(DISTINCT page_id) AS documents FROM page_views WHERE viewed_at >= ? AND viewed_at < ?").get(start, end);
    const types = this.db.prepare(`SELECT COALESCE(NULLIF(p.file_type, ''), 'html') AS type, COUNT(*) AS views
      FROM page_views v JOIN pages p ON p.id = v.page_id WHERE v.viewed_at >= ? AND v.viewed_at < ? GROUP BY type`).all(start, end);
    const byType = { html: 0, pdf: 0, word: 0, other: 0 };
    for (const row of types) byType[Object.hasOwn(byType, row.type) ? row.type : "other"] += row.views;
    return {
      days: window.days, timeZone: window.timeZone, today: window.today,
      generatedAt: now.toISOString(),
      trackingStartedAt,
      summary: {
        ...this.summary(todayStart, end), yesterdayViews: daily.get(yesterdayStart, todayStart).views,
        yesterdayAvailable: trackingStartedAt < todayStart,
        yesterdayComplete: trackingStartedAt <= yesterdayStart,
        periodViews: period.views, periodDocuments: period.documents,
        dailyAverage: trackedDays ? Math.round(period.views / trackedDays * 10) / 10 : 0,
      },
      trend, byType,
      rankings: {
        total: this.ranking("total", todayStart, end, query.totalPage ?? 1),
        today: this.ranking("today", todayStart, end, query.todayPage ?? 1),
      },
    };
  }
}
