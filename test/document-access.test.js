import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/server.js';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liekan-access-'));
  const config = { dataDir, uploadsDir: path.join(dataDir, 'uploads'), generatedDir: path.join(dataDir, 'pages'), versionsDir: path.join(dataDir, 'versions'), publicDir: path.resolve('public'), watchDirs: [], allowSourceWrite: false };
  const app = await buildApp(config);
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'tokdoc' } });
  const admin = String(login.headers['set-cookie']).split(';')[0];
  const create = async (name = 'secret.html', body = '<h1>SECRET BODY</h1>') => app.store.importBuffer({ fileName: name, buffer: Buffer.from(body) });
  const access = (page, policy) => app.inject({ method: 'PATCH', url: `/admin/api/pages/${page.id}/access`, headers: { cookie: admin }, payload: policy });
  const unlock = (page, password = '密码 abc', cookie = '', remember = true, extra = {}) => app.inject({ method: 'POST', url: `/public/api/documents/${page.slug}/unlock`, headers: { origin: 'http://localhost:80', cookie, ...extra }, payload: { password, remember } });
  return { app, config, admin, create, access, unlock };
}
const cookieOf = (response) => String(response.headers['set-cookie'] || '').split(';')[0];

test('static assets retain encoded filenames, reader permissions, HEAD and ranges', async t => {
  const { app, config, access, unlock } = await fixture(t);
  const [page] = await app.store.importUploadFiles([
    { fileName: '指南.html', relativePath: '资料/指南.html', buffer: Buffer.from('<img src="封面%20图.svg">') },
    { fileName: '封面 图.svg', relativePath: '资料/封面 图.svg', buffer: Buffer.from('<svg>ENCODED PRIVATE ASSET</svg>') },
  ]);
  const relative = path.relative(config.uploadsDir, page.sourcePath).split(path.sep);
  relative[relative.length - 1] = '封面 图.svg';
  const encoded = relative.map(encodeURIComponent).join('/');
  const urls = [`/page-assets/${encoded}`, `/document-assets/${page.slug}/${encoded}`];
  for (const url of urls) {
    const publicRead = await app.inject(url);
    assert.equal(publicRead.statusCode, 200);
    assert.match(publicRead.body, /ENCODED PRIVATE ASSET/);
  }
  assert.equal((await access(page, { passwordAction: 'set', password: '密码 abc' })).statusCode, 200);
  for (const url of urls) {
    const denied = await app.inject(url);
    assert.equal(denied.statusCode, 404);
    assert.doesNotMatch(denied.body, /ENCODED PRIVATE ASSET/);
  }
  const cookie = cookieOf(await unlock(page));
  for (const url of urls) {
    const allowed = await app.inject({ url, headers: { cookie } });
    assert.equal(allowed.statusCode, 200);
    assert.match(allowed.headers['content-type'], /image\/svg\+xml/);
    assert.equal(allowed.headers['cache-control'], 'no-store');
    const head = await app.inject({ method: 'HEAD', url, headers: { cookie } });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    const partial = await app.inject({ url, headers: { cookie, range: 'bytes=0-4' } });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.body, '<svg>');
    assert.match(partial.headers['content-range'], /^bytes 0-4\//);
  }
});

test('static plugin keeps UI assets available while private source aliases stay denied', async t => {
  const { app, config, create, access } = await fixture(t);
  const page = await create();
  await access(page, { visibility: 'private' });
  const parts = path.relative(config.uploadsDir, page.sourcePath).split(path.sep);
  const root = parts.shift();
  for (const suffix of [
    parts.join('/'), `./${parts.join('/')}`, `x/../${parts.join('/')}`,
    `%2e%2e/${root}/${parts.join('/')}`, `x%5c..%5c${parts.join('/')}`, '%',
  ]) {
    for (const prefix of [`/page-assets/${root}/`, `/document-assets/${page.slug}/${root}/`]) {
      const response = await app.inject({ url: prefix + suffix });
      assert.ok([400, 403, 404].includes(response.statusCode));
      assert.doesNotMatch(response.body, /SECRET BODY/);
    }
  }
  for (const url of ['/assets/styles/public.css', '/assets/public-app.js']) {
    assert.equal((await app.inject(url)).statusCode, 200);
  }
  assert.equal((await app.inject('/assets/not-a-real-resource.css')).statusCode, 404);
});

test('unlisted documents disappear from every public aggregate and keep their URL', async t => {
  const { app, create, access } = await fixture(t);
  const p = await create();
  assert.equal((await access(p, { visibility: 'public', homepageListed: false, passwordAction: 'keep' })).statusCode, 200);
  for (const url of ['/public/api/pages', '/public/api/pages?q=SECRET', '/public/api/pages?type=html']) {
    const r = await app.inject(url); assert.equal(r.statusCode, 200); assert.equal(r.json().pagination.total, 0); assert.equal(r.json().stats.all, 0); assert.doesNotMatch(r.body, new RegExp(p.slug));
  }
  assert.match((await app.inject(p.url)).body, /SECRET BODY/);
});

test('password gates original, legacy, HEAD, range and raw source, while admin bypasses', async t => {
  const { app, config, admin, create, access, unlock } = await fixture(t);
  const p = await create();
  assert.equal((await access(p, { passwordAction: 'set', password: '密码 abc' })).statusCode, 200);
  const raw = '/page-assets/' + path.relative(config.uploadsDir, p.sourcePath).split(path.sep).join('/');
  for (const url of [p.url, `/pages/${p.slug}.html`, raw]) {
    const r = await app.inject({ url, headers: { range: 'bytes=0-500' } }); assert.doesNotMatch(r.body, /SECRET BODY/); assert.equal(r.headers['cache-control'], 'no-store');
    const head = await app.inject({ method: 'HEAD', url }); assert.equal(head.body, '');
  }
  assert.match((await app.inject(p.url)).body, /这份文档需要访问密码/);
  assert.match((await app.inject({ url: p.url, headers: { cookie: admin } })).body, /SECRET BODY/);
  assert.equal((await unlock(p, 'wrong-password')).statusCode, 401);
  const ok = await unlock(p); assert.equal(ok.statusCode, 200); assert.match(ok.headers['set-cookie'], /HttpOnly/); assert.match(ok.headers['set-cookie'], /SameSite=Lax/); assert.doesNotMatch(ok.headers['set-cookie'], /密码 abc/);
  const cookie = cookieOf(ok);
  for (const url of [p.url, `/pages/${p.slug}.html`, raw]) assert.match((await app.inject({ url, headers: { cookie } })).body, /SECRET BODY/);
  assert.equal((await app.inject({ url: `/api/pages/${p.id}`, headers: { cookie } })).statusCode, 401);
  assert.doesNotMatch(JSON.stringify(app.store.getPage(p.id)), /scrypt\$|access_password_hash/);
});

test('grants are per document, survive restart, and revoke on every policy lifecycle', async t => {
  const { app, create, access, unlock, admin } = await fixture(t);
  const a = await create('a.html'), b = await create('b.html');
  for (const p of [a, b]) await access(p, { passwordAction: 'set', password: '密码 abc' });
  let cookie = cookieOf(await unlock(a));
  assert.match((await app.inject({ url: b.url, headers: { cookie } })).body, /这份文档需要/);
  const rows = app.store.db.prepare('SELECT * FROM reader_grants').all(); assert.equal(rows.length, 1); assert.ok(rows[0].expires_at > Date.now() + 390 * 86400000);
  await unlock(b, '密码 abc', cookie, false);
  const temporary = app.store.db.prepare('SELECT * FROM reader_grants WHERE page_id = ?').get(b.id); assert.ok(temporary.expires_at < Date.now() + 3 * 3600000);
  await app.inject({ method: 'POST', url: `/admin/api/pages/${a.id}/access/revoke`, headers: { cookie: admin }, payload: {} });
  assert.match((await app.inject({ url: a.url, headers: { cookie } })).body, /这份文档需要/);
  cookie = cookieOf(await unlock(a));
  await access(a, { visibility: 'private', passwordAction: 'keep' });
  assert.equal((await app.inject({ url: a.url, headers: { cookie } })).statusCode, 404);
  await access(a, { visibility: 'public', passwordAction: 'keep' });
  assert.match((await app.inject({ url: a.url, headers: { cookie } })).body, /这份文档需要/);
  cookie = cookieOf(await unlock(a)); await app.store.deletePage(a.id); await app.store.restoreDeletedPage(a.id);
  assert.match((await app.inject({ url: a.url, headers: { cookie } })).body, /这份文档需要/);
  await access(a, { passwordAction: 'remove' }); assert.match((await app.inject(a.url)).body, /SECRET BODY/);
});

test('same-origin validation and persisted attempt limits apply before hashing', async t => {
  const { app, create, access, unlock } = await fixture(t); const p = await create(); await access(p, { passwordAction: 'set', password: '密码 abc' });
  assert.equal((await unlock(p, '密码 abc', '', true, { origin: 'http://evil.test' })).statusCode, 403);
  for (let i = 0; i < 10; i++) assert.equal((await unlock(p, 'wrong-password')).statusCode, 401);
  const limited = await unlock(p); assert.equal(limited.statusCode, 429); assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.ok(app.store.db.prepare('SELECT COUNT(*) AS n FROM reader_attempts').get().n > 0);
});

test('managed sources have exact owners and conflicting shared assets reject protection', async t => {
  const { app, config, access, unlock } = await fixture(t);
  const [a,b] = await app.store.importUploadFiles([
    { fileName: 'a.html', relativePath: 'folder/a.html', buffer: Buffer.from('<h1>SECRET BODY</h1><img src="a.png"><img src="shared.png">') },
    { fileName: 'b.html', relativePath: 'folder/b.html', buffer: Buffer.from('<img src="shared.png">') },
    { fileName: 'a.png', relativePath: 'folder/a.png', buffer: Buffer.from('PRIVATE IMAGE') },
    { fileName: 'shared.png', relativePath: 'folder/shared.png', buffer: Buffer.from('SHARED IMAGE') }
  ]);
  const conflict = await access(a, { passwordAction: 'set', password: '密码 abc' }); assert.equal(conflict.statusCode, 409); assert.match(conflict.body, /shared.png/);
  await access(b, { passwordAction: 'set', password: '密码 abc' }); // Shared public owner still prevents partial protection.
  await app.store.savePageContent(b.id, { html: '<h1>public neighbour</h1>' });
  assert.equal((await access(a, { passwordAction: 'set', password: '密码 abc' })).statusCode, 200);
  const raw = '/page-assets/' + path.relative(config.uploadsDir, a.sourcePath).split(path.sep).join('/');
  assert.equal((await app.inject(raw)).statusCode, 404);
  const asset = raw.replace(/a.html$/, 'a.png'); assert.equal((await app.inject(asset)).statusCode, 404);
  const cookie = cookieOf(await unlock(a)); assert.match((await app.inject({ url: asset, headers: { cookie } })).body, /PRIVATE IMAGE/);
});

test('upload access validation runs before any document is published', async t => {
  const { app } = await fixture(t);
  const staged = await app.store.stageUploadFiles([{ fileName: 'a.html', buffer: Buffer.from('<p>A</p>') }, { fileName: 'b.html', buffer: Buffer.from('<p>B</p>') }]);
  await assert.rejects(app.store.confirmStagedUpload(staged.uploadId, { documents: staged.documents.map(d => ({ id: d.id, passwordAction: 'set', password: d.fileName === 'a.html' ? 'correct-password' : 'x' })) }), /6/);
  assert.equal(app.store.listPages().length, 0);
  const pages = await app.store.confirmStagedUpload(staged.uploadId, { documents: staged.documents.map(d => ({ id: d.id, homepageListed: false, passwordAction: 'set', password: 'correct-password' })) });
  for (const p of pages) { assert.equal(p.hasAccessPassword, true); assert.equal(p.homepageListed, false); assert.doesNotMatch((await app.inject(p.url)).body, /<p>[AB]<\/p>/); }
});

test('shared protected resources cannot become public through another owner or restoration', async t => {
  const { app, config, access } = await fixture(t);
  const [a,b] = await app.store.importUploadFiles(['a','b'].map(name => ({fileName:name+'.html',buffer:Buffer.from('<img src="shared.png">'),passwordAction:'set',password:'secret123'})).concat([{fileName:'shared.png',buffer:Buffer.from('SECRET SHARED')} ]));
  const asset = '/page-assets/' + path.relative(config.uploadsDir,a.sourcePath).replace(/a.html$/,'shared.png');
  assert.equal((await app.inject(asset)).statusCode,404);
  assert.equal((await access(a,{passwordAction:'remove'})).statusCode,409);
  assert.equal((await app.inject(asset)).statusCode,404);
  await app.store.deletePage(b.id);
  assert.equal((await access(a,{passwordAction:'remove'})).statusCode,200);
  await assert.rejects(app.store.restoreDeletedPage(b.id),/共享/);
  assert.ok(app.store.getPage(b.id).deletedAt);
});

test('keeping access settings and changing listing retain grants; changing password revokes', async t => {
  const { app, create, access, unlock } = await fixture(t); const p = await create();
  await access(p,{passwordAction:'set',password:'密码 abc'});
  const cookie = cookieOf(await unlock(p));
  for (const setting of [{passwordAction:'keep'}, {homepageListed:false,passwordAction:'keep'}]) {
    assert.equal((await access(p,setting)).statusCode,200);
    assert.match((await app.inject({url:p.url,headers:{cookie}})).body,/SECRET BODY/);
  }
  await access(p,{passwordAction:'set',password:'new password'});
  assert.doesNotMatch((await app.inject({url:p.url,headers:{cookie}})).body,/SECRET BODY/);
  assert.equal((await unlock(p)).statusCode,401);
});

test('PDF and converted Word use the same password gate and restricted sync', async t => {
  const { app, create, access, unlock, admin } = await fixture(t);
  app.store.convertWordToPdf = async (_source,destination) => fs.writeFile(destination,'%PDF-1.4 SECRET PDF');
  for (const name of ['private.pdf','private.docx']) {
    const p = await create(name,'%PDF-1.4 SECRET PDF'); await access(p,{passwordAction:'set',password:'密码 abc'});
    assert.doesNotMatch((await app.inject(p.url)).body,/SECRET PDF/);
    const cookie = cookieOf(await unlock(p));
    const read = await app.inject({url:p.url,headers:{cookie,range:'bytes=0-50'}});
    assert.equal(read.headers['content-type'],'application/pdf'); assert.match(read.body,/SECRET PDF/);
  }
  const html = await create(); await access(html,{homepageListed:false});
  const sync = await app.inject({method:'POST',url:`/api/pages/${html.id}/sync`,headers:{cookie:admin},payload:{}});
  assert.equal(sync.statusCode,400); assert.match(sync.body,/受限文档/);
});

test('resource names, module MIME and dynamic script data survive protection', async t => {
  const { app, config, access, unlock } = await fixture(t);
  const [page] = await app.store.importUploadFiles([
    {fileName:'index.html',relativePath:'folder#1%25/index.html',buffer:Buffer.from('<script type="module" src="app.mjs"></script><link rel="stylesheet" href="style.CSS"><img src="image.png">')},
    {fileName:'app.mjs',relativePath:'folder#1%25/app.mjs',buffer:Buffer.from('fetch("data.json")')},
    {fileName:'data.json',relativePath:'folder#1%25/data.json',buffer:Buffer.from('{"ok":true}')},
    {fileName:'style.CSS',relativePath:'folder#1%25/style.CSS',buffer:Buffer.from('body{background:url(bg.png)}')},
    ...['image.png','bg.png'].map(fileName => ({fileName,relativePath:'folder#1%25/'+fileName,buffer:Buffer.from('IMAGE')}))
  ]);
  const base = '/page-assets/' + path.relative(config.uploadsDir,page.sourcePath).split(path.sep).map(encodeURIComponent).join('/').replace(/index.html$/,'');
  for (const name of ['data.json','style.CSS','image.png','bg.png']) assert.equal((await app.inject(base+name)).statusCode,200);
  await access(page,{passwordAction:'set',password:'密码 abc'});
  assert.equal((await app.inject(base+'data.json')).statusCode,404);
  const cookie = cookieOf(await unlock(page));
  const module = await app.inject({url:base.replace('/page-assets/',`/document-assets/${page.slug}/`)+'app.mjs',headers:{cookie}});
  assert.equal(module.statusCode,200); assert.match(module.headers['content-type'],/javascript/);
  assert.equal((await app.inject({url:base+'data.json',headers:{cookie}})).statusCode,200);
});

test('canonical source aliases cannot borrow permissions from a public neighbour', async t => {
  const { app, config } = await fixture(t);
  const [secret] = await app.store.importUploadFiles([
    {fileName:'Secret.HTML',visibility:'private',buffer:Buffer.from('<p>PRIVATE ORIGINAL</p>')},
    {fileName:'public.html',buffer:Buffer.from('<a href="secret.html">neighbour</a>')}
  ]);
  const root = path.dirname(secret.sourcePath);
  // A symlink exercises the same file-identity boundary on case-sensitive Linux.
  await fs.symlink(secret.sourcePath,path.join(root,'alias.html'));
  const url='/page-assets/'+path.relative(config.uploadsDir,root).split(path.sep).join('/')+'/';
  for (const alias of ['Secret.HTML','secret.html','alias.html']) { const result=await app.inject(url+alias); assert.equal(result.statusCode,404); assert.doesNotMatch(result.body,/PRIVATE ORIGINAL/); }
});

test('HTTPS proxy headers are trusted only from configured proxy addresses', async t => {
  const { app, create, access } = await fixture(t); const p=await create(); await access(p,{passwordAction:'set',password:'secret123'});
  const headers={host:'docs.example.com',origin:'https://docs.example.com','x-forwarded-proto':'https','x-forwarded-for':'198.51.100.7'};
  assert.equal((await app.inject({method:'POST',url:`/public/api/documents/${p.slug}/unlock`,headers,payload:{password:'secret123'}})).statusCode,403);
  const config={...app.config,trustProxy:['loopback']}; await app.close();
  const proxied=await buildApp(config); t.after(()=>proxied.close());
  const result=await proxied.inject({method:'POST',url:`/public/api/documents/${p.slug}/unlock`,headers,payload:{password:'secret123'}});
  assert.equal(result.statusCode,200); assert.match(result.headers['set-cookie'],/Secure/);
  const cookie=cookieOf(result);
  await proxied.close();
  const restarted=await buildApp(config); t.after(()=>restarted.close());
  assert.match((await restarted.inject({url:p.url,headers:{cookie}})).body,/SECRET BODY/);
});

test('upload renaming rejects file identity collisions before publishing', async t => {
  const {app}=await fixture(t);
  const staged=await app.store.stageUploadFiles(['a','b'].map(name=>({fileName:name+'.html',buffer:Buffer.from('<p>'+name+'</p>')})));
  await assert.rejects(app.store.confirmStagedUpload(staged.uploadId,{documents:staged.documents.map((p,i)=>({id:p.id,fileName:i?'Same.html':'same.html',passwordAction:i?'set':'keep',password:'secret123'}))}),/重复/);
  assert.equal(app.store.listPages().length,0);
});

test('watched deleted documents stay in trash through a rescan', async t => {
  const {app,config,access}=await fixture(t);
  const source=path.join(config.dataDir,'watched.html'); await fs.writeFile(source,'<p>SECRET WATCHED</p>');
  const page=await app.store.upsertWatchedFile(source); await access(page,{homepageListed:false,passwordAction:'set',password:'secret123'});
  await app.store.deletePage(page.id); const scanned=await app.store.upsertWatchedFile(source);
  assert.equal(scanned.id,page.id); assert.ok(scanned.deletedAt); assert.equal(app.store.listPages().length,0);
});

test('concurrent edits cannot publish public and protected ownership of the same attachment', async t => {
  const {app,config}=await fixture(t);
  const [a,b]=await app.store.importUploadFiles([{fileName:'a.html',buffer:Buffer.from('<p>A</p>')},{fileName:'b.html',buffer:Buffer.from('<p>B</p>'),passwordAction:'set',password:'secret123'},{fileName:'shared.png',buffer:Buffer.from('SHARED')}]);
  const results=await Promise.allSettled([a,b].map(page=>app.store.savePageContent(page.id,{html:'<html><body><img src="shared.png"></body></html>'})));
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const owners=app.store.db.prepare('SELECT * FROM page_resources WHERE resource_path LIKE ?').all('%shared.png'); assert.equal(owners.length,1);
  if (owners[0].page_id===b.id) assert.equal((await app.inject('/page-assets/'+path.relative(config.uploadsDir,a.sourcePath).replace(/a.html$/,'shared.png'))).statusCode,404);
});

test('a grant issued during deletion cannot survive restore', async t => {
  const {app,create,access,unlock}=await fixture(t); const p=await create(); await access(p,{passwordAction:'set',password:'密码 abc'});
  const resolve=app.store.resolveGeneratedPath.bind(app.store); let release,entered;
  const reached=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);
  app.store.resolveGeneratedPath=async page=>{entered();await barrier;return resolve(page);};
  const deletion=app.store.deletePage(p.id); await reached;
  const cookie=cookieOf(await unlock(p)); release(); await deletion; app.store.resolveGeneratedPath=resolve;
  await app.store.restoreDeletedPage(p.id);
  assert.doesNotMatch((await app.inject({url:p.url,headers:{cookie}})).body,/SECRET BODY/);
});

test('simultaneous document verification reuses the device established by the lock screen',async t=>{
  const {app,create,access,unlock}=await fixture(t);const a=await create('a.html'),b=await create('b.html');
  for(const p of [a,b]) await access(p,{passwordAction:'set',password:'密码 abc'});
  const cookie=cookieOf(await app.inject(a.url));assert.ok(cookie);
  const results=await Promise.all([unlock(a,'密码 abc',cookie),unlock(b,'密码 abc',cookie)]);
  assert.ok(results.every(r=>r.statusCode===200));assert.equal(cookieOf(results[0]),cookieOf(results[1]));
  for(const p of [a,b]) assert.match((await app.inject({url:p.url,headers:{cookie}})).body,/SECRET BODY/);
});

test('saving content checks the current access policy after asynchronous resource discovery',async t=>{
  const {app,config,access}=await fixture(t);const [a,b]=await app.store.importUploadFiles([{fileName:'a.html',buffer:Buffer.from('<p>A</p>')},{fileName:'b.html',buffer:Buffer.from('<img src="shared.png">')},{fileName:'shared.png',buffer:Buffer.from('PUBLIC IMAGE')}]);
  const resources=app.store.access.resources.bind(app.store.access);let enter,release;const entered=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
  app.store.access.resources=async(...args)=>{enter();await barrier;return resources(...args);};
  const save=app.store.savePageContent(a.id,{html:'<html><body><img src="shared.png"></body></html>'});await entered;
  await access(a,{visibility:'private'});release();await assert.rejects(save,/共享/);
  app.store.access.resources=resources;
  const asset='/page-assets/'+path.relative(config.uploadsDir,b.sourcePath).replace(/b.html$/,'shared.png');assert.equal((await app.inject(asset)).statusCode,200);
});

test('failed content write releases its unused resource reservation',async t=>{
  const {app,access}=await fixture(t);const [a]=await app.store.importUploadFiles([{fileName:'a.html',buffer:Buffer.from('<p>A</p>')},{fileName:'b.html',buffer:Buffer.from('<img src="shared.png">')},{fileName:'shared.png',buffer:Buffer.from('IMAGE')}]);
  const resolve=app.store.resolveGeneratedPath.bind(app.store);let calls=0;
  app.store.resolveGeneratedPath=async page=>{if(++calls===2)throw Object.assign(new Error('disk unavailable'),{code:'EIO'});return resolve(page);};
  await assert.rejects(app.store.savePageContent(a.id,{html:'<html><body><img src="shared.png"></body></html>'}),/disk unavailable/);
  app.store.resolveGeneratedPath=resolve;
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM page_resources WHERE page_id=?').get(a.id).n,0);
  assert.equal((await access(a,{passwordAction:'set',password:'secret123'})).statusCode,200);
});
