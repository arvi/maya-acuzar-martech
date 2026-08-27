import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintIdTransformer } from '../../common/transformers/bigint.transformer';
import type { AuthIdentity } from './auth-identity.entity';
import { CorporateHolder } from './corporate-holder.entity';

/** A natural person authorised to act for a corporate holder. */
@Entity({ name: 'corporate_signatories' })
export class CorporateSignatory {
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    insert: false,
    update: false,
    transformer: bigintIdTransformer,
  })
  id: number;

  @Column({
    name: 'corporate_holder_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  corporateHolderId: number;

  @Column({ type: 'text' })
  fullName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(
    () => CorporateHolder,
    (holder) => holder.signatories,
  )
  @JoinColumn({ name: 'corporate_holder_id' })
  corporateHolder?: CorporateHolder;

  @OneToMany(
    'AuthIdentity',
    (identity: AuthIdentity) => identity.corporateSignatory,
  )
  authIdentities?: AuthIdentity[];
}
