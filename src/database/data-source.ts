import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './data-source.options';

// Only the CLI loads env file directly.
loadEnv();

// Export Datasource instance used by TypeORM CLI
export default new DataSource({
  ...buildDataSourceOptions(process.env.DATABASE_URL),

  // The CLI runs TypeScript directly via ts-node, so these point at source
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
});
