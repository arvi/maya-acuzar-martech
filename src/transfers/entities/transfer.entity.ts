import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import type { Currency, TransferStatus } from '../../common/domain.types';
import {
  bigintIdTransformer,
  bigintTransformer,
} from '../../common/transformers/bigint.transformer';
import { AuthIdentity } from '../../holders/entities/auth-identity.entity';

@Entity({ name: 'transfers' })
export class Transfer {
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
    name: 'source_account_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  sourceAccountId: number;

  @Column({
    name: 'destination_account_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  destinationAccountId: number;

  /** PHP centavos; the schema enforces > 0. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amountMinor: number;

  @Column({ type: 'char', length: 3, default: 'PHP' })
  currency: Currency;

  @Column({ type: 'text', default: 'pending' })
  status: TransferStatus;

  /**
   * NULL means no idempotency key was provided. Keys are unique per caller, so
   * different callers may use the same key safely.
   */
  @Column({ type: 'text', nullable: true })
  idempotencyKey: string | null;

  /** NULL means an automated transfer without a user identity e.g reversal. */
  @Column({
    name: 'initiated_by_auth_identity_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintIdTransformer,
  })
  initiatedByAuthIdentityId: number | null;

  /** NULL = transfer has not failed. */
  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  /** NULL = sender attached no note. Max 100 chars, enforced by the schema. */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** NULL = not yet posted to the ledger. */
  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'source_account_id' })
  sourceAccount?: Account;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'destination_account_id' })
  destinationAccount?: Account;

  @ManyToOne(() => AuthIdentity, { nullable: true })
  @JoinColumn({ name: 'initiated_by_auth_identity_id' })
  initiatedBy?: AuthIdentity | null;
}
