import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { OutboxStatus } from '../../common/domain.types';
import { bigintIdTransformer } from '../../common/transformers/bigint.transformer';

/**
 * Transactional outbox. Rows are written in the same transaction as the state
 * change they describe, so an event cannot be published for a transfer that
 * rolled back, nor lost for one that committed.
 */
@Entity({ name: 'outbox_events' })
export class OutboxEvent {
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    insert: false,
    update: false,
    transformer: bigintIdTransformer,
  })
  id: number;

  @Column({ type: 'text' })
  aggregateType: string;

  /** NULL = event not associated with a specific aggregate row. */
  @Column({
    name: 'aggregate_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintIdTransformer,
  })
  aggregateId: number | null;

  @Column({ type: 'text' })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** NULL = event not yet published to the broker. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
