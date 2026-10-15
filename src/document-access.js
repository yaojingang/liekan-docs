import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseHTML } from 'linkedom';

const scrypt = promisify(crypto.scrypt);
const LONG = 400 * 86400000;
const SHORT = 2 * 3600000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
export function accessError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode, code: 'DOCUMENT_ACCESS' }); }
export function cookies(header = '') {
  const result = {};
  for (const item of String(header).split(';')) {
    const i = item.indexOf('='); if (i < 0) continue;
    try { result[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1)); } catch { /* Ignore malformed cookie values. */ }
  }
  return result;
}

export class DocumentAccess {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES ('reader_instance',?,?)").run(crypto.randomBytes(8).toString('hex'), new Date().toISOString());
    this.cookieName = 'lkdoc_reader_' + this.db.prepare("SELECT value FROM settings WHERE key='reader_instance'").get().value;
  }
  row(id) { return this.db.prepare('SELECT * FROM pages WHERE id=?').get(id); }
  async policy(input = {}, previous = {}) {
    const visibility = input.visibility ?? previous.visibility ?? 'public';
    if (!['public', 'private'].includes(visibility)) throw accessError('请选择有效的访问方式');
    const listed = input.homepageListed ?? Boolean(previous.homepage_listed ?? 1);
    if (typeof listed !== 'boolean') throw accessError('首页展示设置无效');
    const action = input.passwordAction ?? 'keep';
    if (!['keep','set','remove'].includes(action)) throw accessError('密码操作无效');
    let hash = previous.access_password_hash || '';
    if (action === 'remove') hash = '';
    if (action === 'set') {
      const password = input.password;
      if (typeof password !== 'string' || [...password].length < 6 || [...password].length > 128 || !password.trim()) throw accessError('访问密码须为 6–128 个字符，且不能全部为空格');
      const salt = crypto.randomBytes(16).toString('hex');
      hash = `scrypt$${salt}$${(await scrypt(password, salt, 32)).toString('hex')}`;
    }
    return { visibility, homepageListed: listed, accessPasswordHash: hash };
  }
  async verify(password, encoded) {
    if (typeof password !== 'string' || [...password].length > 128) return false;
    const [,salt,hash] = String(encoded).split('$'); if (!salt || !hash) return false;
    const actual = await scrypt(password, salt, 32), expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  device(request) {
    const token = cookies(request.headers.cookie)[this.cookieName];
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const row = this.db.prepare('SELECT * FROM reader_devices WHERE token_hash=? AND expires_at>?').get(digest(token), Date.now());
    return row ? { ...row, token } : null;
  }
  cookie(request, reply, token, remember) {
    reply.header('set-cookie', `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${request.protocol === 'https' ? '; Secure' : ''}${remember ? '; Max-Age=34560000' : ''}`);
  }
  ensureDevice(request, reply) {
    if (this.device(request)) return;
    this.db.prepare('DELETE FROM reader_devices WHERE expires_at<?').run(Date.now());
    const pending = this.db.prepare('SELECT COUNT(*) AS n FROM reader_devices d WHERE NOT EXISTS (SELECT 1 FROM reader_grants g WHERE g.device_id=d.id)').get().n;
    if (pending >= 1000) return; // Validated readers can still obtain their device at unlock.
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO reader_devices(id,token_hash,expires_at,persistent) VALUES(?,?,?,0)').run(crypto.randomUUID(),digest(token),Date.now()+SHORT);
    this.cookie(request,reply,token,false);
  }
  allowed(page, request, reply) {
    const row = this.row(page.id);
    if (!row || row.deleted_at || row.visibility === 'private') return false;
    if (!row.access_password_hash) return true;
    const device = this.device(request); if (!device) return false;
    const grant = this.db.prepare('SELECT * FROM reader_grants WHERE device_id=? AND page_id=? AND access_version=? AND expires_at>?').get(device.id, page.id, row.access_version, Date.now());
    if (!grant) return false;
    if (grant.remember && reply) {
      const expires = Date.now() + LONG;
      this.db.prepare('UPDATE reader_grants SET expires_at=? WHERE device_id=? AND page_id=?').run(expires, device.id, page.id);
      this.db.prepare('UPDATE reader_devices SET expires_at=?, persistent=1 WHERE id=?').run(expires, device.id);
      this.cookie(request, reply, device.token, true);
    }
    return true;
  }
  revoke(id) {
    this.db.prepare('UPDATE pages SET access_version=access_version+1 WHERE id=?').run(id);
    this.db.prepare('DELETE FROM reader_grants WHERE page_id=?').run(id);
  }
  attempt(ip, id) {
    const now = Date.now(), start = now - 300000;
    this.db.prepare('DELETE FROM reader_attempts WHERE created_at<?').run(start);
    this.db.prepare('DELETE FROM reader_devices WHERE expires_at<?').run(now);
    this.db.prepare('DELETE FROM reader_grants WHERE expires_at<?').run(now);
    const key = digest(ip);
    const counts = this.db.prepare('SELECT COUNT(*) AS total, SUM(page_id=?) AS document, MIN(created_at) AS oldest FROM reader_attempts WHERE ip_hash=?').get(id, key);
    if (counts.total >= 60 || counts.document >= 10) throw Object.assign(accessError('验证次数较多，请稍后再试。',429), { retryAfter: Math.max(1, Math.ceil((counts.oldest + 300000 - now) / 1000)) });
    this.db.prepare('INSERT INTO reader_attempts(ip_hash,page_id,created_at) VALUES(?,?,?)').run(key,id,now);
  }
  async unlock(page, request, reply) {
    let origin;
    try { origin = new URL(request.headers.origin || '').origin; } catch { throw accessError('请从文档页面输入访问密码',403); }
    if (origin !== new URL(`${request.protocol}://${request.headers.host}`).origin || request.headers['sec-fetch-site'] === 'cross-site') throw accessError('请从文档页面输入访问密码',403);
    let row = this.row(page.id);
    if (!row || row.deleted_at || row.visibility === 'private') throw accessError('文档暂不可访问',404);
    if (!row.access_password_hash) return { ok: true };
    this.attempt(request.ip, page.id);
    if (!await this.verify(request.body?.password, row.access_password_hash)) throw accessError('密码不正确，请检查后重试。',401);
    const current = this.row(page.id);
    if (!current || current.deleted_at || current.visibility === 'private' || current.access_version !== row.access_version || current.access_password_hash !== row.access_password_hash) throw accessError('访问权限已更新，请重新输入密码。',409);
    const remember = request.body?.remember !== false;
    let device = this.device(request);
    const token = device?.token || crypto.randomBytes(32).toString('base64url');
    const expiry = Date.now() + (remember ? LONG : SHORT);
    if (!device) {
      device = { id: crypto.randomUUID(), persistent: Number(remember) };
      this.db.prepare('INSERT INTO reader_devices(id,token_hash,expires_at,persistent) VALUES(?,?,?,?)').run(device.id,digest(token),expiry,Number(remember));
    } else this.db.prepare('UPDATE reader_devices SET expires_at=MAX(expires_at,?),persistent=MAX(persistent,?) WHERE id=?').run(expiry,Number(remember),device.id);
    this.db.prepare('INSERT INTO reader_grants(device_id,page_id,access_version,remember,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(device_id,page_id) DO UPDATE SET access_version=excluded.access_version,remember=excluded.remember,expires_at=excluded.expires_at').run(device.id,page.id,row.access_version,Number(remember),expiry);
    this.cookie(request, reply, token, remember || Boolean(device.persistent));
    return { ok: true };
  }
  async resources(sourcePath, html) {
    if (!sourcePath || !inside(path.resolve(this.store.config.uploadsDir), path.resolve(sourcePath))) return [];
    const root = path.resolve(this.store.config.uploadsDir), found = new Set(), scanned = new Set();
    const sourceUrl = new URL('/page-assets/' + path.relative(root, sourcePath).split(path.sep).map(encodeURIComponent).join('/'), 'http://document.local');
    const { document } = parseHTML(html);
    let base = sourceUrl;
    try { if (document.querySelector('base[href]')) base = new URL(document.querySelector('base[href]').getAttribute('href'), sourceUrl); } catch { /* Invalid document base has no local resources. */ }
    const collect = async (ref, context) => {
      let url; try { url = new URL(ref, context); } catch { return; }
      if (url.origin !== sourceUrl.origin || !url.pathname.startsWith('/page-assets/')) return;
      let decoded; try { decoded = decodeURIComponent(url.pathname.slice(13)); } catch { return; }
      const target = path.resolve(root, decoded);
      if (!inside(root,target) || target === sourcePath) return;
      let canonical = target; try { canonical = await fs.realpath(target); } catch { /* Keep missing reference ownership. */ }
      found.add(canonical);
      if (target.toLowerCase().endsWith('.css') && !scanned.has(target)) {
        scanned.add(target);
        try { await css(await fs.readFile(target,'utf8'),url); } catch { /* Missing references stay owned and denied to unrelated readers. */ }
      }
    };
    const css = async (text, context) => { for (const match of text.matchAll(/(?:url\(\s*['"]?([^'"\)\s]+)|@import\s+['"]([^'"]+))/g)) await collect(match[1] || match[2],context); };
    for (const el of document.querySelectorAll('[src],[href],[poster],[data],[srcset],[style]')) {
      for (const attr of ['src','href','poster','data']) if (el.hasAttribute(attr) && el.localName !== 'base') await collect(el.getAttribute(attr),base);
      for (const value of (el.getAttribute('srcset') || '').split(',')) if (value.trim()) await collect(value.trim().split(/\s+/)[0],base);
      if (el.hasAttribute('style')) await css(el.getAttribute('style'),base);
    }
    for (const el of document.querySelectorAll('style')) await css(el.textContent,base);
    // Script-generated URLs cannot be inferred from HTML. Own the upload's
    // non-document files conservatively so mixed policies require separation.
    if (document.querySelector('script')) {
      const uploadRoot = path.join(root, path.relative(root,sourcePath).split(path.sep)[0]);
      const walk = async directory => {
        for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
          const file = path.join(directory,entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile() && !/\.(?:html?|pdf|docx?)$/i.test(file)) found.add(await fs.realpath(file));
        }
      };
      await walk(uploadRoot);
    }
    return [...found];
  }
  registerResources(id, resources) {
    this.db.prepare('DELETE FROM page_resources WHERE page_id=?').run(id);
    const insert = this.db.prepare('INSERT OR IGNORE INTO page_resources(page_id,resource_path) VALUES(?,?)');
    for (const resource of resources) insert.run(id,resource);
  }
  async refreshResources(page, html) { this.registerResources(page.id, await this.resources(page.sourcePath, html)); }
  async seedResources() {
    for (const page of this.store.listPages()) if (page.fileType === 'html') {
      try { await this.refreshResources(page,await this.store.readPageHtml(page)); } catch { /* Unreadable documents retain existing resource ownership. */ }
    }
  }
  conflict(id, policy, resources) {
    const restricted = Boolean(policy.accessPasswordHash) || policy.visibility === 'private';
    const conflicts = [];
    for (const resource of resources || this.db.prepare('SELECT resource_path FROM page_resources WHERE page_id=?').all(id).map(r => r.resource_path)) {
      const others = this.db.prepare(`SELECT p.id,p.title FROM page_resources r JOIN pages p ON p.id=r.page_id WHERE r.resource_path=? AND p.id<>? AND p.deleted_at IS NULL AND ${restricted ? "p.visibility='public' AND COALESCE(p.access_password_hash,'')=''" : "(p.visibility='private' OR COALESCE(p.access_password_hash,'')<>'')"}`).all(resource,id);
      if (others.length) conflicts.push(`${path.relative(this.store.config.uploadsDir,resource)}（${others.map(p=>p.title).join('、')}）`);
    }
    if (conflicts.length) throw accessError('附件与公开文档共享，请将相关文档一起保护，或整理到独立目录后重新导入：' + conflicts.join('；'),409);
  }
  async update(id, input) {
    const old = this.row(id); if (!old || old.deleted_at) return null;
    const policy = await this.policy(input, old);
    const current = this.row(id);
    if (!current || current.deleted_at || current.access_version !== old.access_version || current.visibility !== old.visibility || current.homepage_listed !== old.homepage_listed || current.access_password_hash !== old.access_password_hash) throw accessError('访问设置已更新，请刷新后重试',409);
    this.conflict(id,policy);
    const invalidate = policy.accessPasswordHash !== old.access_password_hash || (policy.visibility === 'private' && old.visibility !== 'private');
    this.db.prepare('UPDATE pages SET visibility=?,homepage_listed=?,access_password_hash=?,access_version=access_version+?,updated_at=? WHERE id=?').run(policy.visibility,Number(policy.homepageListed),policy.accessPasswordHash,Number(invalidate),new Date().toISOString(),id);
    if (invalidate) this.db.prepare('DELETE FROM reader_grants WHERE page_id=?').run(id);
    return this.store.getPage(id);
  }
  async owners(target) {
    const exact = [];
    for (const row of this.db.prepare('SELECT * FROM pages WHERE source_path IS NOT NULL').all()) {
      try { if (await fs.realpath(await this.store.resolveManagedPath(row.source_path)) === target) exact.push(row); } catch { /* Missing sources cannot alias existing files. */ }
    }
    if (exact.length) return exact.map(row=>({...row,managedSource:true})); // A managed source always follows its own document.
    return this.db.prepare('SELECT p.* FROM page_resources r JOIN pages p ON p.id=r.page_id WHERE r.resource_path=?').all(target);
  }
  async asset(rootId, relative, request, reply, scopedSlug = '') {
    reply.header('cache-control','no-store');
    if (!/^[a-z0-9-]{20,80}$/i.test(rootId) || relative.split(/[\\/]/).some(p => p === '..' || p === '.') || /[\0\\]/.test(relative)) return false;
    const root = path.resolve(this.store.config.uploadsDir,rootId), target = path.resolve(root,relative);
    if (!inside(root,target)) return false;
    try { if (!inside(await fs.realpath(root),await fs.realpath(target))) return false; } catch { return false; }
    const owners = (await this.owners(await fs.realpath(target))).filter(row => !row.deleted_at);
    const admin = Object.entries(cookies(request.headers.cookie)).some(([name,token]) => ['tokdoc_session','tokhtml_session'].includes(name) && this.store.verifySessionToken(token));
    if (admin) return true;
    if (scopedSlug && !owners.some(p=>p.slug === scopedSlug)) return false;
    const mixed = owners.some(p=>p.visibility === 'public' && !p.access_password_hash) && owners.some(p=>p.visibility === 'private' || p.access_password_hash);
    if (owners.some(p=>p.managedSource) || mixed) return owners.length > 0 && owners.every(row=>this.allowed({id:row.id},request,reply));
    return owners.some(row => (!scopedSlug || row.slug === scopedSlug) && this.allowed({id:row.id},request,reply));
  }
}
