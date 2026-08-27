import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuthenticatedIdentity } from '../auth/identity.types';
import { SUPPORTED_CURRENCY } from '../common/domain.types';
import {
  EXECUTE_STALE_SUMMARY,
  SendMoneyRuleViolation,
} from '../common/errors/send-money-error';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { Transfer } from '../transfers/entities/transfer.entity';
import { ExecuteTransferDto } from './dto/execute-transfer.dto';
import { ResolutionResponseDto } from './dto/resolution-response.dto';
import { ResolveTransferDto } from './dto/resolve-transfer.dto';
import { SendMoneyReceiptDto } from './dto/send-money-receipt.dto';
import { ResolvedParty } from './recipient-resolver.service';
import { ResolutionTokenService } from './resolution-token.service';
import { SendMoneyRulesService } from './send-money-rules.service';

@Injectable()
export class SendMoneyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rules: SendMoneyRulesService,
    private readonly tokens: ResolutionTokenService,
  ) {}

  /**
   * Phase one. Read-only: it validates and issues a token, and moves nothing.
   */
  async resolve(
    dto: ResolveTransferDto,
    identity: AuthenticatedIdentity,
  ): Promise<ResolutionResponseDto> {
    const amountMinor = dto.resolvedAmountMinor();

    const result = await this.rules.evaluate(
      {
        senderHolderId: identity.accountHolderId,
        recipientType: dto.recipient.type,
        recipientValue: dto.recipient.value,
        amountMinor,
      },
      this.dataSource.manager,
    );

    if (result.errors.length > 0) {
      throw new SendMoneyRuleViolation(result.errors);
    }

    // Both are defined whenever errors is empty; the checks keep TypeScript
    // honest rather than guarding a reachable case.
    const sender = result.sender!;
    const recipient = result.recipient!;
    const note = dto.note ?? null;

    const { token, expiresAt } = await this.tokens.sign({
      aid: identity.authIdentityId,
      src: sender.accountId,
      dst: recipient.accountId,
      amt: amountMinor,
      note,
    });

    return ResolutionResponseDto.from({
      token,
      expiresAt,
      displayName: recipient.displayName,
      amountMinor,
      note,
    });
  }

  /**
   * Phase two. Everything happens in one transaction: if the ledger write
   * fails, the balance update and the outbox event roll back with it, so the
   * cached balance can never drift from the ledger and no event is published
   * for a transfer that did not happen.
   */
  async execute(
    dto: ExecuteTransferDto,
    identity: AuthenticatedIdentity,
    idempotencyKey: string,
  ): Promise<SendMoneyReceiptDto> {
    if (!idempotencyKey) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'Send an Idempotency-Key header. Without one a retry would send twice.',
      });
    }

    const claims = await this.tokens.verify(
      dto.resolutionToken,
      identity.authIdentityId,
    );

    return this.dataSource.transaction(async (manager) => {
      const replay = await this.findReplay(
        manager,
        idempotencyKey,
        identity.authIdentityId,
      );
      if (replay) return replay;

      // Lock in a deterministic order. Two opposing transfers between the same
      // pair of accounts would otherwise each hold one row and wait on the
      // other; ordering by id makes that deadlock impossible.
      const locked = await manager.query(
        `SELECT a.id, a.account_holder_id, a.balance_minor, a.status AS account_status,
                h.display_name, h.status AS holder_status
           FROM accounts a
           JOIN account_holders h ON h.id = a.account_holder_id
          WHERE a.id = ANY($1::bigint[])
          ORDER BY a.id
            FOR UPDATE OF a`,
        [[claims.src, claims.dst]],
      );

      const byId = new Map<number, (typeof locked)[number]>(
        locked.map((row: { id: string }) => [Number(row.id), row]),
      );

      const source = byId.get(claims.src);
      const destination = byId.get(claims.dst);

      if (!source || !destination) {
        throw new NotFoundException({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'An account in this confirmation no longer exists.',
        });
      }

      const sender = toParty(source);
      const recipient = toParty(destination);

      // The token is up to 120 seconds stale and balances move, so every rule
      // runs again against the locked rows. The token was only ever a hint.
      const errors = await this.rules.evaluateResolved(
        sender,
        recipient,
        claims.amt,
        manager,
      );

      if (errors.length > 0) {
        // Same codes as phase one; the summary is what tells a client this was
        // a stale confirmation rather than a request that was never valid.
        throw new SendMoneyRuleViolation(errors, EXECUTE_STALE_SUMMARY);
      }

      return this.post(
        manager,
        claims,
        sender,
        recipient,
        identity,
        idempotencyKey,
      );
    });
  }

  /**
   * A replayed idempotency key must return the original transfer rather than
   * moving money a second time. The unique index is scoped per initiating
   * identity, and this lookup matches that scope.
   */
  private async findReplay(
    manager: EntityManager,
    idempotencyKey: string,
    authIdentityId: number,
  ): Promise<SendMoneyReceiptDto | null> {
    const existing = await manager.getRepository(Transfer).findOne({
      where: {
        idempotencyKey,
        initiatedByAuthIdentityId: authIdentityId,
      },
      relations: { destinationAccount: { accountHolder: true } },
    });

    if (!existing) return null;

    return SendMoneyReceiptDto.from({
      reference: existing.publicId,
      recipientName:
        existing.destinationAccount?.accountHolder?.displayName ?? 'Recipient',
      amountMinor: existing.amountMinor,
      note: existing.note,
      postedAt: existing.postedAt ?? existing.createdAt,
    });
  }

  /** Writes the transfer, the double-entry pair, the balances and the event. */
  private async post(
    manager: EntityManager,
    claims: { src: number; dst: number; amt: number; note: string | null },
    sender: ResolvedParty,
    recipient: ResolvedParty,
    identity: AuthenticatedIdentity,
    idempotencyKey: string,
  ): Promise<SendMoneyReceiptDto> {
    // Inserted directly as 'posted'. The whole method runs inside one
    // transaction and the ledger write below either commits with it or rolls
    // back, so an intermediate 'pending' row would never be observable.
    let transferId: number;
    try {
      const [inserted] = await manager.query(
        `INSERT INTO transfers
           (source_account_id, destination_account_id, amount_minor,
            status, posted_at, note, idempotency_key, initiated_by_auth_identity_id)
         VALUES ($1, $2, $3, 'posted', now(), $4, $5, $6)
         RETURNING id`,
        [
          claims.src,
          claims.dst,
          claims.amt,
          claims.note,
          idempotencyKey,
          identity.authIdentityId,
        ],
      );
      transferId = Number(inserted.id);
    } catch (error) {
      // Two concurrent requests with the same key: the unique index rejects
      // the loser. Returning the winner's transfer is the point of the key.
      if (isUniqueViolation(error)) {
        const replay = await this.findReplay(
          manager,
          idempotencyKey,
          identity.authIdentityId,
        );
        if (replay) return replay;
      }
      throw error;
    }

    const newSourceBalance = sender.balanceMinor - claims.amt;
    const newDestinationBalance = recipient.balanceMinor + claims.amt;

    // balance_after_minor is recorded per entry so the ledger alone can be
    // replayed and audited without recomputing running totals.
    await manager.getRepository(LedgerEntry).insert([
      {
        transferId,
        accountId: claims.src,
        direction: 'debit',
        amountMinor: claims.amt,
        balanceAfterMinor: newSourceBalance,
      },
      {
        transferId,
        accountId: claims.dst,
        direction: 'credit',
        amountMinor: claims.amt,
        balanceAfterMinor: newDestinationBalance,
      },
    ]);

    // Relative deltas rather than absolute values: the rows are locked, so this
    // is equivalent, and it keeps accounts_balance_not_negative_chk as the
    // authority on overdrafts.
    await manager.query(
      `UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2`,
      [claims.amt, claims.src],
    );
    await manager.query(
      `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`,
      [claims.amt, claims.dst],
    );

    // Read back through the repository so the entity mapping applies; building
    // the response from raw RETURNING rows would hand back undefined for every
    // camelCase property.
    const transfer = await manager
      .getRepository(Transfer)
      .findOneOrFail({ where: { id: transferId } });

    await manager.getRepository(OutboxEvent).insert({
      aggregateType: 'transfer',
      aggregateId: transferId,
      eventType: 'transfer.posted',
      payload: {
        transferId: transfer.publicId,
        amountMinor: claims.amt,
        currency: SUPPORTED_CURRENCY,
      },
    });

    return SendMoneyReceiptDto.from({
      reference: transfer.publicId,
      recipientName: recipient.displayName,
      amountMinor: claims.amt,
      note: claims.note,
      postedAt: transfer.postedAt ?? transfer.createdAt,
    });
  }
}

interface LockedAccountRow {
  id: string;
  account_holder_id: string;
  balance_minor: string;
  account_status: string;
  display_name: string;
  holder_status: string;
}

function toParty(row: LockedAccountRow): ResolvedParty {
  return {
    accountId: Number(row.id),
    accountHolderId: Number(row.account_holder_id),
    displayName: row.display_name,
    balanceMinor: Number(row.balance_minor),
    accountStatus: row.account_status,
    holderStatus: row.holder_status,
  };
}

/**
 * Postgres unique_violation. TypeORM wraps driver errors in QueryFailedError,
 * which sometimes surfaces the SQLSTATE at the top level and sometimes only on
 * driverError, so both are checked.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { code, driverError } = error as {
    code?: string;
    driverError?: { code?: string };
  };

  return code === '23505' || driverError?.code === '23505';
}
