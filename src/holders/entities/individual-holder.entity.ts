import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { HolderType } from '../../common/domain.types';
import { bigintIdTransformer } from '../../common/transformers/bigint.transformer';
import { AccountHolder } from './account-holder.entity';

/**
 * Subtype sharing its PK with account_holders (1:1). There is no surrogate key:
 * account_holder_id is both PK and FK, which is what makes the 1:1 unforgeable.
 */
@Entity({ name: 'individual_holders' })
export class IndividualHolder {
  @PrimaryColumn({
    name: 'account_holder_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  accountHolderId: number;

  /**
   * GENERATED ALWAYS AS ('individual') STORED. Postgres computes it, so it is
   * insert/update-disabled here; it exists to feed the composite FK back to
   * account_holders(id, holder_type).
   */
  @Column({ type: 'text', insert: false, update: false })
  holderType: HolderType;

  @Column({ type: 'text' })
  firstName: string;

  /** NULL = holder has no middle name on record. */
  @Column({ type: 'text', nullable: true })
  middleName: string | null;

  @Column({ type: 'text' })
  lastName: string;

  @Column({ type: 'date' })
  dateOfBirth: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(
    () => AccountHolder,
    (holder) => holder.individualHolder,
  )
  @JoinColumn({ name: 'account_holder_id' })
  accountHolder?: AccountHolder;
}
