import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CALENDAR_BOUNDARY_TIMEZONE } from '../common/domain.types';
import { AccountLimit } from './entities/account-limit.entity';

export interface LimitUsage {
  dailyUsedMinor: number;
  monthlyUsedMinor: number;
}

export interface LimitEvaluation extends LimitUsage {
  limit: AccountLimit;
  dailyRemainingMinor: number;
  monthlyRemainingMinor: number;
}

@Injectable()
export class AccountLimitsService {
  constructor(
    @InjectRepository(AccountLimit)
    private readonly limitRepository: Repository<AccountLimit>,
  ) {}

  findByHolder(accountHolderId: number): Promise<AccountLimit | null> {
    return this.limitRepository.findOne({ where: { accountHolderId } });
  }

  /**
   * Sums posted debits across every account the holder owns, inside the current
   * day and month windows.
   *
   * The windows are computed in CALENDAR_BOUNDARY_TIMEZONE via Postgres
   * (`AT TIME ZONE` + `date_trunc`) rather than in JS. Doing it in Node would
   * mean reimplementing DST-aware month boundaries against the server's local
   * clock, which is a different clock from the one the product promises.
   *
   * Only 'posted' transfers count: pending ones have not moved money, and
   * failed/reversed ones must not consume a customer's headroom.
   */
  async getUsage(
    accountHolderId: number,
    manager: EntityManager,
  ): Promise<LimitUsage> {
    const [row] = await manager.query(
      `
      WITH holder_accounts AS (
        SELECT id FROM accounts WHERE account_holder_id = $1
      ),
      bounds AS (
        SELECT
          date_trunc('day',   now() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start,
          date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2 AS month_start
      )
      SELECT
        COALESCE(SUM(le.amount_minor)
          FILTER (WHERE le.posted_at >= bounds.day_start), 0)   AS daily_used,
        COALESCE(SUM(le.amount_minor)
          FILTER (WHERE le.posted_at >= bounds.month_start), 0) AS monthly_used
      FROM ledger_entries le
      CROSS JOIN bounds
      WHERE le.account_id IN (SELECT id FROM holder_accounts)
        AND le.direction = 'debit'
        AND le.posted_at >= bounds.month_start
      `,
      [accountHolderId, CALENDAR_BOUNDARY_TIMEZONE],
    );

    return {
      dailyUsedMinor: Number(row.daily_used),
      monthlyUsedMinor: Number(row.monthly_used),
    };
  }

  /** Usage plus remaining headroom, floored at zero. */
  async evaluate(
    limit: AccountLimit,
    manager: EntityManager,
  ): Promise<LimitEvaluation> {
    const usage = await this.getUsage(limit.accountHolderId, manager);

    return {
      limit,
      ...usage,
      dailyRemainingMinor: Math.max(
        0,
        limit.dailyLimitMinor - usage.dailyUsedMinor,
      ),
      monthlyRemainingMinor: Math.max(
        0,
        limit.monthlyLimitMinor - usage.monthlyUsedMinor,
      ),
    };
  }
}
