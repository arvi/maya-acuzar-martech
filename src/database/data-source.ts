import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './data-source.options';

// Only the CLI loads env file directly.
loadEnv();

// __filename ends in .ts under the CLI (ts-node) and .js once `nest build`
// compiles this file to dist/, so the same DataSource works for both the
// TypeORM CLI and the compiled migrate-and-seed entrypoint.
const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

// Export Datasource instance used by TypeORM CLI
export default new DataSource({
  ...buildDataSourceOptions(process.env.DATABASE_URL),

  entities: [`${__dirname}/../**/*.entity.${ext}`],
  migrations: [`${__dirname}/migrations/*.${ext}`],
});
