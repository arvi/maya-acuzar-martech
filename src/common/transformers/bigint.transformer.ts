import type { ValueTransformer } from 'typeorm';

/**
 * PostgreSQL returns BIGINT values as strings because they may exceed JavaScript’s
 * safe integer range. Since money is stored in centavos, convert these values to
 * numbers only when the conversion is lossless (without changing any info); otherwise, throw an error instead
 * of risking incorrect calculations.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: number | null): number | null => value,

  from: (value: string | null): number | null => {
    if (value === null) return null;

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `BIGINT value ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be represented exactly in JavaScript.`,
      );
    }

    return parsed;
  },
};

/**
 * Identity columns are always non-null and read-only, so nullable handling
 * is unnecessary for primary and foreign key mappings.
 */
export const bigintIdTransformer: ValueTransformer = {
  to: (value: number): number => value,
  from: (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `BIGINT id ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be represented exactly in JavaScript.`,
      );
    }
    return parsed;
  },
};
