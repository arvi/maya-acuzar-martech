import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AccountStatus, Currency } from '../../common/domain.types';
import {
  bigintIdTransformer,
  bigintTransformer,
} from '../../common/transformers/bigint.transformer';
import { AccountHolder } from '../../holders/entities/account-holder.entity';

@Entity({ name: 'accounts' })
export class Account {
  /** Internal sequence; expose only publicId through the API. */
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    insert: false,
    update: false,
    transformer: bigintIdTransformer,
  })
  id: number;

  /** Opaque external identifier; expose this instead of sequential id */
  @Column({ type: 'uuid', insert: false, update: false })
  publicId: string;

  @Column({
    name: 'account_holder_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  accountHolderId: number;

  /** NULL = account has no account number on record. */
  @Column({ type: 'text', nullable: true })
  accountNumber: string | null;

  @Column({ type: 'char', length: 3, default: 'PHP' })
  currency: Currency;

  /** Cached balance in PHP centavos for fast reads; the ledger (source of truth) remains authoritative. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  balanceMinor: number;

  @Column({ type: 'text', default: 'active' })
  status: AccountStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(
    () => AccountHolder,
    (holder) => holder.accounts,
  )
  @JoinColumn({ name: 'account_holder_id' })
  accountHolder?: AccountHolder;
}
