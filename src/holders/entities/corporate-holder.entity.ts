import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { HolderType } from '../../common/domain.types';
import { bigintIdTransformer } from '../../common/transformers/bigint.transformer';
import { AccountHolder } from './account-holder.entity';
import type { CorporateSignatory } from './corporate-signatory.entity';

/** Subtype sharing its PK with account_holders (1:1). See IndividualHolder. */
@Entity({ name: 'corporate_holders' })
export class CorporateHolder {
  @PrimaryColumn({
    name: 'account_holder_id',
    type: 'bigint',
    transformer: bigintIdTransformer,
  })
  accountHolderId: number;

  /** GENERATED ALWAYS AS ('corporate') STORED; see IndividualHolder.holderType. */
  @Column({ type: 'text', insert: false, update: false })
  holderType: HolderType;

  @Column({ type: 'text' })
  legalName: string;

  /** NULL = holder has no SEC/registration number on record. */
  @Column({ type: 'text', nullable: true })
  registrationNumber: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(
    () => AccountHolder,
    (holder) => holder.corporateHolder,
  )
  @JoinColumn({ name: 'account_holder_id' })
  accountHolder?: AccountHolder;

  @OneToMany(
    'CorporateSignatory',
    (signatory: CorporateSignatory) => signatory.corporateHolder,
  )
  signatories?: CorporateSignatory[];
}
