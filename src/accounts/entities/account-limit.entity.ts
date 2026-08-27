import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Currency } from '../../common/domain.types';
import {
  bigintIdTransformer,
  bigintTransformer,
} from '../../common/transformers/bigint.transformer';
import { AccountHolder } from '../../holders/entities/account-holder.entity';

/**
 * Limits are per account_holder, not per account: they apply across every
 * account the holder owns, so usage must be summed over all of them.
 */
@Entity({ name: 'account_limits' })
export class AccountLimit {
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    insert: false,
    update: false,
    transformer: bigintIdTransformer,
  })
  id: number;

  @Column({
    name: 'account_holder_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  accountHolderId: number;

  @Column({ type: 'char', length: 3, default: 'PHP' })
  currency: Currency;

  /** Max outbound per day in PHP centavos. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  dailyLimitMinor: number;

  /** Max outbound per month in PHP centavos. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  monthlyLimitMinor: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(
    () => AccountHolder,
    (holder) => holder.limit,
  )
  @JoinColumn({ name: 'account_holder_id' })
  accountHolder?: AccountHolder;
}
