import dataSource from '../data-source';
import { seed, truncate } from './seed-data';

/**
 * Entry point for `npm run db:seed`.
 *
 * `--reset` (`npm run db:seed:reset`) truncates the seeded tables first, so the
 * fixture can be rebuilt without tearing down the container or re-running
 * migrations (deletes every row in those tables, not just seeded ones).
 */
async function run(): Promise<void> {
  const reset = process.argv.includes('--reset');

  if (reset && process.env.NODE_ENV === 'production') {
    throw new Error('Not allowed to run --reset with NODE_ENV=production.');
  }

  await dataSource.initialize();
  try {
    if (reset) {
      await truncate(dataSource);
    }
    await seed(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

run().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
