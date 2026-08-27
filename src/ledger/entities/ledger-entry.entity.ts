import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import type { Currency, LedgerDirection } from '../../common/domain.types';
import {
  bigintIdTransformer,
  bigintTransformer,
} from '../../common/transformers/bigint.transformer';
import { Transfer } from '../../transfers/entities/transfer.entity';

/**
 * Immutable double-entry ledger. Database triggers reject updates and deletes,
 * so corrections use compensating reversal entries instead.
 *
 * There is no updatedAt because ledger rows cannot change. All columns are
 * update-disabled to prevent TypeORM from generating rejected updates.
 */
@Entity({ name: 'ledger_entries' })
export class LedgerEntry {
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    insert: false,
    update: false,
    transformer: bigintIdTransformer,
  })
  id: number;

  /** NULL = manual adjustment or fee not tied to a transfer. */
  @Column({
    name: 'transfer_id',
    type: 'bigint',
    nullable: true,
    update: false,
    transformer: bigintIdTransformer,
  })
  transferId: number | null;

  @Column({
    name: 'account_id',
    type: 'bigint',
    update: false,
    transformer: bigintIdTransformer,
  })
  accountId: number;

  @Column({ type: 'text', update: false })
  direction: LedgerDirection;

  /** Always positive; `direction` carries the sign. */
  @Column({ type: 'bigint', update: false, transformer: bigintTransformer })
  amountMinor: number;

  @Column({ type: 'char', length: 3, default: 'PHP', update: false })
  currency: Currency;

  /** NULL = running balance snapshot not computed at write time. */
  @Column({
    type: 'bigint',
    nullable: true,
    update: false,
    transformer: bigintTransformer,
  })
  balanceAfterMinor: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()', update: false })
  postedAt: Date;

  @CreateDateColumn({ type: 'timestamptz', update: false })
  createdAt: Date;

  @ManyToOne(() => Transfer, { nullable: true })
  @JoinColumn({ name: 'transfer_id' })
  transfer?: Transfer | null;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;
}
