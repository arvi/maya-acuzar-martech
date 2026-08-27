import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AccountLimitsService } from '../accounts/account-limits.service';
import { AccountLimit } from '../accounts/entities/account-limit.entity';
import { SUPPORTED_CURRENCY } from '../common/domain.types';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransferResponseDto } from './dto/transfer-response.dto';
import { Transfer } from './entities/transfer.entity';

@Injectable()
export class TransfersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly limitsService: AccountLimitsService,
  ) {}

  async findByPublicId(publicId: string): Promise<TransferResponseDto> {
    const transfer = await this.dataSource.getRepository(Transfer).findOne({
      where: { publicId },
      relations: { sourceAccount: true, destinationAccount: true },
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer ${publicId} not found.`);
    }

    return TransferResponseDto.from(
      transfer,
      transfer.sourceAccount!.publicId,
      transfer.destinationAccount!.publicId,
    );
  }

  /**
   * Executes a send-money transfer.
   *
   * Everything happens in one transaction: if the ledger write fails, the
   * balance update and the outbox event roll back with it, so the cached
   * balance can never drift from the ledger and no event is published for a
   * transfer that did not happen.
   */
  async create(
    dto: CreateTransferDto,
    initiatedByAuthIdentityId: number | null,
  ): Promise<TransferResponseDto> {
    // The DTO accepts pesos or centavos; both are normalised to centavos by
    // validation, so everything below this line works in one unit.
    const amountMinor = dto.resolvedAmountMinor();

    if (dto.sourceAccountId === dto.destinationAccountId) {
      throw new BadRequestException(
        'Source and destination accounts must differ.',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      if (dto.idempotencyKey) {
        const replay = await this.findReplay(
          manager,
          dto.idempotencyKey,
          initiatedByAuthIdentityId,
        );
        if (replay) return replay;
      }

      // Lock in a deterministic order. Two opposing transfers between the same
      // pair of accounts would otherwise each hold one row and wait on the
      // other; ordering by public id makes that deadlock impossible.
      const [firstId, secondId] = [
        dto.sourceAccountId,
        dto.destinationAccountId,
      ].sort();

      const locked = await manager.query(
        `SELECT id, public_id, account_holder_id, balance_minor, status, currency
           FROM accounts
          WHERE public_id = ANY($1::uuid[])
          ORDER BY public_id
            FOR UPDATE`,
        [[firstId, secondId]],
      );

      const byPublicId = new Map<string, (typeof locked)[number]>(
        locked.map((row: { public_id: string }) => [row.public_id, row]),
      );
      const source = byPublicId.get(dto.sourceAccountId);
      const destination = byPublicId.get(dto.destinationAccountId);

      if (!source) {
        throw new NotFoundException(
          `Source account ${dto.sourceAccountId} not found.`,
        );
      }
      if (!destination) {
        throw new NotFoundException(
          `Destination account ${dto.destinationAccountId} not found.`,
        );
      }

      this.assertTransferable(source, 'Source');
      this.assertTransferable(destination, 'Destination');

      const sourceBalance = Number(source.balance_minor);
      if (sourceBalance < amountMinor) {
        throw new UnprocessableEntityException({
          message: 'Insufficient funds.',
          balanceMinor: sourceBalance,
          requestedMinor: amountMinor,
        });
      }

      await this.assertWithinLimits(
        manager,
        Number(source.account_holder_id),
        amountMinor,
      );

      return this.post(
        manager,
        dto,
        amountMinor,
        source,
        destination,
        initiatedByAuthIdentityId,
      );
    });
  }

  private assertTransferable(
    account: { status: string; currency: string },
    role: string,
  ): void {
    if (account.status !== 'active') {
      throw new UnprocessableEntityException(
        `${role} account is ${account.status}; only active accounts can transact.`,
      );
    }
    if (account.currency !== SUPPORTED_CURRENCY) {
      throw new UnprocessableEntityException(
        `${role} account is denominated in ${account.currency}; only ${SUPPORTED_CURRENCY} is supported.`,
      );
    }
  }

  /**
   * A replayed idempotency key must return the original transfer rather than
   * moving money a second time. The unique index is scoped per initiating
   * identity, and this lookup matches that scope.
   */
  private async findReplay(
    manager: EntityManager,
    idempotencyKey: string,
    initiatedByAuthIdentityId: number | null,
  ): Promise<TransferResponseDto | null> {
    // IsNull() rather than a bare null: in SQL `= NULL` matches nothing, so a
    // system-initiated replay would never find its original and would send twice.
    const existing = await manager.getRepository(Transfer).findOne({
      where: {
        idempotencyKey,
        initiatedByAuthIdentityId:
          initiatedByAuthIdentityId === null
            ? IsNull()
            : initiatedByAuthIdentityId,
      },
      relations: { sourceAccount: true, destinationAccount: true },
    });

    if (!existing) return null;

    return TransferResponseDto.from(
      existing,
      existing.sourceAccount!.publicId,
      existing.destinationAccount!.publicId,
    );
  }

  private async assertWithinLimits(
    manager: EntityManager,
    accountHolderId: number,
    amountMinor: number,
  ): Promise<void> {
    const limit = await manager
      .getRepository(AccountLimit)
      .findOne({ where: { accountHolderId } });

    // No configured limit means unlimited. Made explicit because the safer
    // reading — deny by default — would block every holder seeded without one.
    if (!limit) return;

    const usage = await this.limitsService.getUsage(accountHolderId, manager);

    if (usage.dailyUsedMinor + amountMinor > limit.dailyLimitMinor) {
      throw new UnprocessableEntityException({
        message: 'Daily send limit exceeded.',
        limitMinor: limit.dailyLimitMinor,
        usedMinor: usage.dailyUsedMinor,
        requestedMinor: amountMinor,
      });
    }

    if (usage.monthlyUsedMinor + amountMinor > limit.monthlyLimitMinor) {
      throw new UnprocessableEntityException({
        message: 'Monthly send limit exceeded.',
        limitMinor: limit.monthlyLimitMinor,
        usedMinor: usage.monthlyUsedMinor,
        requestedMinor: amountMinor,
      });
    }
  }

  /** Writes the transfer, the double-entry pair, the balances and the event. */
  private async post(
    manager: EntityManager,
    dto: CreateTransferDto,
    amountMinor: number,
    source: { id: string; public_id: string; balance_minor: string },
    destination: { id: string; public_id: string; balance_minor: string },
    initiatedByAuthIdentityId: number | null,
  ): Promise<TransferResponseDto> {
    const sourceId = Number(source.id);
    const destinationId = Number(destination.id);

    // Inserted directly as 'posted' with posted_at set. The whole method runs
    // inside one transaction and the ledger write below either commits with it
    // or rolls it back, so an intermediate 'pending' row would never be
    // observable by another session — writing it and then updating it would be
    // two writes to reach the same committed state.
    let transferId: number;
    try {
      const [inserted] = await manager.query(
        `INSERT INTO transfers
           (source_account_id, destination_account_id, amount_minor,
            status, posted_at, idempotency_key, initiated_by_auth_identity_id)
         VALUES ($1, $2, $3, 'posted', now(), $4, $5)
         RETURNING id`,
        [
          sourceId,
          destinationId,
          amountMinor,
          dto.idempotencyKey ?? null,
          initiatedByAuthIdentityId,
        ],
      );
      transferId = Number(inserted.id);
    } catch (error) {
      // Two concurrent requests with the same key: the unique index rejects the
      // loser. Returning the winner's transfer is the whole point of the key.
      if (isUniqueViolation(error) && dto.idempotencyKey) {
        const replay = await this.findReplay(
          manager,
          dto.idempotencyKey,
          initiatedByAuthIdentityId,
        );
        if (replay) return replay;
      }
      throw error;
    }

    const newSourceBalance = Number(source.balance_minor) - amountMinor;
    const newDestinationBalance =
      Number(destination.balance_minor) + amountMinor;

    // balance_after_minor is recorded per entry so the ledger alone can be
    // replayed and audited without recomputing running totals.
    await manager.getRepository(LedgerEntry).insert([
      {
        transferId,
        accountId: sourceId,
        direction: 'debit',
        amountMinor: amountMinor,
        balanceAfterMinor: newSourceBalance,
      },
      {
        transferId,
        accountId: destinationId,
        direction: 'credit',
        amountMinor: amountMinor,
        balanceAfterMinor: newDestinationBalance,
      },
    ]);

    // Written as a relative delta rather than an absolute value: the rows are
    // locked, so this is equivalent, and it keeps accounts_balance_not_negative_chk
    // as the authority on overdrafts.
    await manager.query(
      `UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2`,
      [amountMinor, sourceId],
    );
    await manager.query(
      `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2`,
      [amountMinor, destinationId],
    );

    // Read back through the repository so the entity mapping (snake_case
    // columns, bigint transformer) applies. Building the response from raw
    // RETURNING rows would hand back undefined for every camelCase property.
    const transfer = await manager.getRepository(Transfer).findOneOrFail({
      where: { id: transferId },
    });

    // TODO: emit a domain event via @nestjs/event-emitter once it is added, so
    // in-process listeners (notifications, analytics) can react to a posted
    // transfer. The outbox row below stays regardless: it is the durable,
    // transactional record for downstream consumers, whereas an in-process
    // event is lost on crash. The emit belongs *after* this transaction
    // commits, not inside it.
    await manager.getRepository(OutboxEvent).insert({
      aggregateType: 'transfer',
      aggregateId: transferId,
      eventType: 'transfer.posted',
      payload: {
        transferId: transfer.publicId,
        sourceAccountId: source.public_id,
        destinationAccountId: destination.public_id,
        amountMinor: amountMinor,
        currency: SUPPORTED_CURRENCY,
      },
    });

    return TransferResponseDto.from(
      transfer,
      source.public_id,
      destination.public_id,
    );
  }
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
