import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Account } from '../../accounts/entities/account.entity';
import type { AccountLimit } from '../../accounts/entities/account-limit.entity';
import type { HolderStatus, HolderType } from '../../common/domain.types';
import { bigintIdTransformer } from '../../common/transformers/bigint.transformer';
import type { AuthIdentity } from './auth-identity.entity';
import type { CorporateHolder } from './corporate-holder.entity';
import type { IndividualHolder } from './individual-holder.entity';

/**
 * Base holder (supertype) record. `holder_type` identifies the subtype (individual, corporate) table, and the
 * composite key prevents mismatched subtype references.
 */
@Entity({ name: 'account_holders' })
export class AccountHolder {
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    insert: false,
    update: false,
    transformer: bigintIdTransformer,
  })
  id: number;

  @Column({ type: 'text' })
  holderType: HolderType;

  @Column({ type: 'text' })
  displayName: string;

  @Column({ type: 'text', default: 'active' })
  status: HolderStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(
    'IndividualHolder',
    (individual: IndividualHolder) => individual.accountHolder,
  )
  individualHolder?: IndividualHolder | null;

  @OneToOne(
    'CorporateHolder',
    (corporate: CorporateHolder) => corporate.accountHolder,
  )
  corporateHolder?: CorporateHolder | null;

  @OneToMany('Account', (account: Account) => account.accountHolder)
  accounts?: Account[];

  @OneToOne('AccountLimit', (limit: AccountLimit) => limit.accountHolder)
  limit?: AccountLimit | null;

  @OneToMany('AuthIdentity', (identity: AuthIdentity) => identity.accountHolder)
  authIdentities?: AuthIdentity[];
}
