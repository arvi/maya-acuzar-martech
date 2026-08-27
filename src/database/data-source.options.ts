import { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export function buildDataSourceOptions(
  url: string | undefined,
): DataSourceOptions {
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not defined.');
  }

  return {
    type: 'postgres' as const,
    url,
    // The schema is owned by the SQL migration, not by TypeORM.
    synchronize: false,
    logging: process.env.NODE_ENV === 'development',

    // Without this every camelCase property would map to a column that does not exist.
    namingStrategy: new SnakeNamingStrategy(),
  };
}
