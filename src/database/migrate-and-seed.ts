import dataSource from './data-source';
import { seed } from './seeds/seed-data';

/**
 * Entry point for the one-shot `migrate` compose service.
 *
 * Compiled to dist/database/migrate-and-seed.js by `nest build`, so the
 * production image needs neither ts-node nor the TypeORM CLI.
 *
 * Idempotent: runMigrations() skips what is already applied and seed()
 * short-circuits on its marker subject, so re-running `docker compose up` is
 * safe.
 */
async function run(): Promise<void> {
  await dataSource.initialize();

  try {
    const applied = await dataSource.runMigrations();
    console.log(
      applied.length > 0
        ? `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`
        : 'Schema already up to date.',
    );

    await seed(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

run().catch((error) => {
  console.error('Migrate and seed failed:', error);
  process.exit(1);
});
