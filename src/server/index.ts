import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/kysely.js';
import { startSweeper } from './workers/sweeper.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // Compiled layout: dist/server/index.js → SPA in dist/web.
  const webDist = config.WEB_DIST_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../web');
  const db = createDb({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });
  const app = await buildApp({ config: { ...config, WEB_DIST_DIR: webDist }, db });

  const sweeper = startSweeper(db, {
    onResult: (r) => { if (r.expired || r.keysPurged) app.log.info({ sweep: r }, 'hold sweep'); },
    onError: (err) => app.log.error({ err }, 'hold sweep failed'),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await sweeper.stop();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
