import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintIdTransformer } from '../../common/transformers/bigint.transformer';
import { AccountHolder } from './account-holder.entity';
import { CorporateSignatory } from './corporate-signatory.entity';

/** A login. Maps a Keycloak subject onto the holder it may act for. */
@Entity({ name: 'auth_identities' })
export class AuthIdentity {
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

  /**
   * NULL = identity is an individual holder, not a corporate signatory login.
   * When set, a composite FK forces the signatory to belong to this same
   * account_holder_id.
   */
  @Column({
    name: 'corporate_signatory_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintIdTransformer,
  })
  corporateSignatoryId: number | null;

  /** Keycloak JWT "sub" claim; stable per identity. */
  @Column({ type: 'text' })
  subject: string;

  /** PH mobile (09XXXXXXXXX); login credential. */
  @Column({ type: 'text' })
  mobileNumber: string;

  @Column({ type: 'text' })
  username: string;

  @Column({ type: 'text' })
  email: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(
    () => AccountHolder,
    (holder) => holder.authIdentities,
  )
  @JoinColumn({ name: 'account_holder_id' })
  accountHolder?: AccountHolder;

  @ManyToOne(
    () => CorporateSignatory,
    (signatory) => signatory.authIdentities,
    { nullable: true },
  )
  @JoinColumn({ name: 'corporate_signatory_id' })
  corporateSignatory?: CorporateSignatory | null;
}
