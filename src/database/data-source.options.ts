import { DataSourceOptions } from 'typeorm';

export function buildDataSourceOptions(
  url: string | undefined,
): DataSourceOptions {
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not defined.');
  }

  return {
    type: 'postgres' as const,
    url,
    synchronize: false,
    logging: process.env.NODE_ENV === 'development',
  };
}
