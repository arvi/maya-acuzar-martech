import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SendMoneyErrorCode } from '../common/errors/send-money-error';

export type RecipientLookupType = 'username' | 'mobileNumber';

export interface ResolvedParty {
  accountId: number;
  accountHolderId: number;
  displayName: string;
  balanceMinor: number;
  accountStatus: string;
  holderStatus: string;
}

export type ResolutionOutcome =
  | { ok: true; party: ResolvedParty }
  | {
      ok: false;
      code: SendMoneyErrorCode;
      details?: Record<string, unknown>;
    };

type Side = 'sender' | 'recipient';

/** Which error code family a failure belongs to, by side. */
const CODES = {
  sender: {
    notFound: SendMoneyErrorCode.SenderNoActiveAccount,
    notActive: SendMoneyErrorCode.SenderNoActiveAccount,
    none: SendMoneyErrorCode.SenderNoActiveAccount,
    ambiguous: SendMoneyErrorCode.SenderAmbiguousAccount,
  },
  recipient: {
    notFound: SendMoneyErrorCode.RecipientNotFound,
    notActive: SendMoneyErrorCode.RecipientNotActive,
    none: SendMoneyErrorCode.RecipientNoActiveAccount,
    ambiguous: SendMoneyErrorCode.RecipientAmbiguousAccount,
  },
} as const;

interface PartyRow {
  account_id: string;
  account_holder_id: string;
  display_name: string;
  balance_minor: string;
  account_status: string;
  holder_status: string;
}

@Injectable()
export class RecipientResolverService {
  /**
   * username or mobile number → the holder's single active account.
   *
   * A corporate signatory needs no special case: auth_identities carries the
   * corporate account_holder_id directly, and auth_identities_signatory_holder_fk
   * forces the signatory to belong to that same holder.
   */
  async resolveByLookup(
    type: RecipientLookupType,
    value: string,
    manager: EntityManager,
  ): Promise<ResolutionOutcome> {
    const column = type === 'username' ? 'ai.username' : 'ai.mobile_number';

    const rows: PartyRow[] = await manager.query(
      `SELECT a.id            AS account_id,
              h.id            AS account_holder_id,
              h.display_name  AS display_name,
              a.balance_minor AS balance_minor,
              a.status        AS account_status,
              h.status        AS holder_status
         FROM auth_identities ai
         JOIN account_holders h ON h.id = ai.account_holder_id
         LEFT JOIN accounts a   ON a.account_holder_id = h.id
        WHERE ${column} = $1`,
      [value],
    );

    if (rows.length === 0) {
      return { ok: false, code: CODES.recipient.notFound };
    }

    return this.pickActive(rows, 'recipient');
  }

  /** The same rule from a holder id, for the sender side. */
  async resolveByHolder(
    accountHolderId: number,
    manager: EntityManager,
    side: Side,
  ): Promise<ResolutionOutcome> {
    const rows: PartyRow[] = await manager.query(
      `SELECT a.id            AS account_id,
              h.id            AS account_holder_id,
              h.display_name  AS display_name,
              a.balance_minor AS balance_minor,
              a.status        AS account_status,
              h.status        AS holder_status
         FROM account_holders h
         LEFT JOIN accounts a ON a.account_holder_id = h.id
        WHERE h.id = $1`,
      [accountHolderId],
    );

    if (rows.length === 0) {
      return { ok: false, code: CODES[side].notFound };
    }

    return this.pickActive(rows, side);
  }

  private pickActive(rows: PartyRow[], side: Side): ResolutionOutcome {
    // A LEFT JOIN yields one row with a NULL account when the holder has none.
    const accounts = rows.filter((row) => row.account_id !== null);

    if (accounts.length === 0) {
      return { ok: false, code: CODES[side].none };
    }

    const active = accounts.filter((row) => row.account_status === 'active');

    if (active.length === 0) {
      // Report the status rather than a bare "no active account": a suspended
      // recipient is a different problem from one who never opened an account.
      const [first] = accounts;
      const status =
        first.holder_status !== 'active'
          ? first.holder_status
          : first.account_status;

      return {
        ok: false,
        code: CODES[side].notActive,
        details: { status },
      };
    }

    if (active.length > 1) {
      // Deliberately not "pick the oldest". A wallet that guesses which of your
      // accounts to use is one that will eventually guess wrong, and the sender
      // has no way to tell which it chose.
      return {
        ok: false,
        code: CODES[side].ambiguous,
        details: { accountCount: active.length },
      };
    }

    const [row] = active;

    // The holder can be non-active while an account still reads 'active'.
    if (row.holder_status !== 'active') {
      return {
        ok: false,
        code: CODES[side].notActive,
        details: { status: row.holder_status },
      };
    }

    return {
      ok: true,
      party: {
        accountId: Number(row.account_id),
        accountHolderId: Number(row.account_holder_id),
        displayName: row.display_name,
        balanceMinor: Number(row.balance_minor),
        accountStatus: row.account_status,
        holderStatus: row.holder_status,
      },
    };
  }
}
