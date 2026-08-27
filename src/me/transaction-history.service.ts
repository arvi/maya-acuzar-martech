import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  CALENDAR_BOUNDARY_TIMEZONE,
  type LedgerDirection,
} from '../common/domain.types';
import { TransactionHistoryQueryDto } from './dto/transaction-history-query.dto';
import { TransactionHistoryItemDto } from './dto/transaction-history-response.dto';

/** Returned when the caller names no range. */
export const DEFAULT_HISTORY_LIMIT = 5;

/**
 * Ceiling on a ranged query. An unbounded scan over a wide range is the one
 * way this endpoint misbehaves under load. Applied with DESC ordering, so what
 * a caller loses is the oldest rows rather than the newest.
 */
export const MAX_HISTORY_LIMIT = 100;

interface HistoryRow {
  reference: string;
  direction: LedgerDirection;
  counterparty_name: string;
  amount_minor: string;
  note: string | null;
  posted_at: Date;
}

@Injectable()
export class TransactionHistoryService {
  /**
   * Posted transfers touching any account the holder owns, newest first.
   *
   * Reads ledger_entries rather than transfers: one row per leg means the
   * holder's own perspective comes for free — their debit leg is a send, their
   * credit leg is a receive — and a self-transfer correctly appears twice.
   *
   * Keyed by holder id, like limit usage: no account identifier is accepted
   * from a caller.
   */
  async forHolder(
    accountHolderId: number,
    manager: EntityManager,
    query: TransactionHistoryQueryDto,
  ): Promise<TransactionHistoryItemDto[]> {
    const params: unknown[] = [accountHolderId];
    const conditions: string[] = [];

    // Dates name Manila calendar days, converted in Postgres. Doing it in Node
    // would mean reimplementing DST-aware boundaries against the server's
    // clock, which is a different clock from the one the product promises.
    if (query.from) {
      params.push(query.from);
      conditions.push(
        `le.posted_at >= $${params.length}::date AT TIME ZONE '${CALENDAR_BOUNDARY_TIMEZONE}'`,
      );
    }

    if (query.to) {
      params.push(query.to);
      // Exclusive of the next midnight, so a transfer at 23:30 PHT on the `to`
      // date is in range. Comparing against `to` at 00:00 would drop the day.
      conditions.push(
        `le.posted_at < ($${params.length}::date + INTERVAL '1 day') AT TIME ZONE '${CALENDAR_BOUNDARY_TIMEZONE}'`,
      );
    }

    const ranged = Boolean(query.from || query.to);
    params.push(ranged ? MAX_HISTORY_LIMIT : DEFAULT_HISTORY_LIMIT);

    const rows: HistoryRow[] = await manager.query(
      `SELECT t.public_id            AS reference,
              le.direction           AS direction,
              counterparty.display_name AS counterparty_name,
              le.amount_minor        AS amount_minor,
              t.note                 AS note,
              le.posted_at           AS posted_at
         FROM ledger_entries le
         JOIN accounts a  ON a.id = le.account_id
         JOIN transfers t ON t.id = le.transfer_id
         -- The counterparty is whichever leg is not this entry's own account.
         JOIN accounts counterparty_account
           ON counterparty_account.id = CASE
                WHEN le.account_id = t.source_account_id
                  THEN t.destination_account_id
                ELSE t.source_account_id
              END
         JOIN account_holders counterparty
           ON counterparty.id = counterparty_account.account_holder_id
        WHERE a.account_holder_id = $1
          AND le.transfer_id IS NOT NULL
          AND t.status = 'posted'
          ${conditions.map((condition) => `AND ${condition}`).join('\n          ')}
        ORDER BY le.posted_at DESC, le.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return rows.map((row) =>
      TransactionHistoryItemDto.from({
        reference: row.reference,
        direction: row.direction,
        counterpartyName: row.counterparty_name,
        amountMinor: Number(row.amount_minor),
        note: row.note,
        postedAt: row.posted_at,
      }),
    );
  }
}
