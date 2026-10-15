import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { PageStore } from './page-store.js';
import { WatchService } from './watch-service.js';
import { registerRoutes } from './routes.js';

export async function buildApp(config = loadConfig()) {
  const app = Fastify({ logger: true, trustProxy: config.trustProxy?.length ? config.trustProxy : false });
  const db = createDb(config);
  const store = new PageStore(config, db);
  await store.ensureStorage();
  await store.seedConfiguredWatchDirs();
  await store.access.seedResources();

  const watchService = new WatchService(store);

  app.decorate('config', config);
  app.decorate('store', store);
  app.decorate('watchService', watchService);

  app.addHook('preHandler', async (request, reply) => {
    const pathname = new URL(request.url, 'http://document.local').pathname;
    if (!pathname.startsWith('/page-assets/') && !pathname.startsWith('/document-assets/')) return;
    let parts;
    try { parts = pathname.split('/').slice(2).map(decodeURIComponent); } catch { return reply.code(404).header('cache-control','no-store').send({error:'Page asset not found'}); }
    const slug = pathname.startsWith('/document-assets/') ? parts.shift() : '';
    if (!await store.access.asset(parts.shift() || '', parts.join('/'), request, reply, slug)) return reply.code(404).send(request.method === 'HEAD' ? undefined : {error:'Page asset not found'});
  });

  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 200,
    },
  });

  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/assets/',
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: config.uploadsDir,
    serve: false,
    decorateReply: true,
    dotfiles: 'deny',
    index: false,
  });

  app.get('/page-assets/:root/*', async (request, reply) => {
    return reply.header('cache-control','no-store').sendFile(`${request.params.root}/${request.params['*']}`,config.uploadsDir,{cacheControl:false,dotfiles:'deny',index:false});
  });

  app.get('/document-assets/:slug/:root/*', async (request, reply) => {
    return reply.header('cache-control','no-store').sendFile(`${request.params.root}/${request.params['*']}`,config.uploadsDir,{cacheControl:false,dotfiles:'deny',index:false});
  });

  registerRoutes(app);

  app.addHook('onReady', async () => {
    await watchService.start();
  });

  app.addHook('onClose', async () => {
    await watchService.stop();
    db.close();
  });

  return app;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`猎看文档系统 listening at http://${config.host}:${config.port}`);
}
