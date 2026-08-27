/**
 * Mirrors of the CHECK constraints in the initial schema migration. The database
 * is the authority; these exist so TypeScript rejects a bad literal at compile
 * time instead of waiting for a 23514 check_violation at runtime.
 */

export const HOLDER_TYPES = ['individual', 'corporate'] as const;
export type HolderType = (typeof HOLDER_TYPES)[number];

export const HOLDER_STATUSES = ['active', 'suspended', 'closed'] as const;
export type HolderStatus = (typeof HOLDER_STATUSES)[number];

export const ACCOUNT_STATUSES = ['active', 'suspended', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const TRANSFER_STATUSES = [
  'pending',
  'posted',
  'failed',
  'reversed',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const LEDGER_DIRECTIONS = ['debit', 'credit'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const OUTBOX_STATUSES = ['pending', 'published', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** accounts_currency_chk / transfers_currency_chk pin every row to PHP. */
export const SUPPORTED_CURRENCY = 'PHP';
export type Currency = typeof SUPPORTED_CURRENCY;

/**
 * IANA zone whose midnight defines the calendar boundaries of the daily and
 * monthly limit windows. The PH product rolls over at Manila midnight, not UTC.
 *
 * A constant rather than a column: it is the same for every holder, so storing
 * it per row invited rows to disagree with a product rule that has no per-row
 * variation. Windows are still computed in Postgres (`AT TIME ZONE`), which is
 * DST-aware; this only supplies the zone.
 */
export const CALENDAR_BOUNDARY_TIMEZONE = 'Asia/Manila';
