import type { DataSource, EntityManager } from 'typeorm';
import { pesosToMinor } from '../../common/money';

/**
 * Test data for the send money flow.
 *
 * Idempotent — `seed()` skips a database that already carries these rows.
 */

/** Sentinel checked to decide whether the fixture is already loaded. */
const SEED_MARKER_SUBJECT = 'seed-adelaida-magtalas';

/**
 * Peso amounts below → centavos, parsed off the decimal string.
 *
 * Not `major * 100`: that is float multiplication, so php(19.99) would give
 * 1998.9999999999998 and the fixture would open an account a centavo light.
 * Accepts up to 2 decimal places, matching what the API accepts.
 */
const php = (major: string | number): number => pesosToMinor(major);

/**
 * Applies to every holder: PHP 50,000/day, PHP 500,000/month in centavos, per
 * the product default.
 */
const DEFAULT_LIMITS = {
  dailyLimitMinor: php(50_000),
  monthlyLimitMinor: php(500_000),
};

/** A login. Individual holders get one; corporates get one per signatory. */
interface IdentitySeed {
  /** Keycloak `sub`. */
  subject: string;
  username: string;
  email: string;
  /** PH mobile, 09XXXXXXXXX. */
  mobileNumber: string;
  /** Matches a `signatories[].fullName` on a corporate holder; unset for individuals. */
  signatoryName?: string;
}

interface AccountSeed {
  accountNumber: string;
  /** Credited to the account by an opening ledger entry. */
  openingBalanceMinor: number;
}

interface LimitSeed {
  dailyLimitMinor: number;
  monthlyLimitMinor: number;
}

interface IndividualSeed {
  kind: 'individual';
  displayName: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  /** ISO date. */
  dateOfBirth: string;
  identities: IdentitySeed[];
  accounts: AccountSeed[];
  limits: LimitSeed;
}

interface CorporateSeed {
  kind: 'corporate';
  displayName: string;
  legalName: string;
  registrationNumber: string | null;
  signatories: string[];
  identities: IdentitySeed[];
  accounts: AccountSeed[];
  limits: LimitSeed;
}

type HolderSeed = IndividualSeed | CorporateSeed;

export const HOLDER_SEEDS: HolderSeed[] = [
  {
    kind: 'individual',
    displayName: 'Adelaida Magtalas',
    firstName: 'Adelaida',
    lastName: 'Magtalas',
    dateOfBirth: '1979-02-17',
    identities: [
      {
        subject: SEED_MARKER_SUBJECT,
        username: 'adelaida.magtalas',
        email: 'adelaida.magtalas@example.com',
        mobileNumber: '09170000101',
      },
    ],
    accounts: [
      { accountNumber: '1000000001', openingBalanceMinor: php('85000.75') },
    ],
    limits: DEFAULT_LIMITS,
  },
  {
    kind: 'individual',
    displayName: 'Ethan Del Rosario',
    firstName: 'Ethan',
    lastName: 'Del Rosario',
    dateOfBirth: '1994-06-09',
    identities: [
      {
        subject: 'seed-ethan-del-rosario',
        username: 'ethan.delrosario',
        email: 'ethan.delrosario@example.com',
        mobileNumber: '09170000102',
      },
    ],
    accounts: [
      { accountNumber: '1000000002', openingBalanceMinor: php('62500.05') },
    ],
    limits: DEFAULT_LIMITS,
  },
  {
    kind: 'individual',
    displayName: 'Joy Marie Fabregas',
    firstName: 'Joy',
    middleName: 'Marie',
    lastName: 'Fabregas',
    dateOfBirth: '1988-11-30',
    identities: [
      {
        subject: 'seed-joy-marie-fabregas',
        username: 'joy.fabregas',
        email: 'joy.fabregas@example.com',
        mobileNumber: '09170000103',
      },
    ],
    accounts: [
      { accountNumber: '1000000003', openingBalanceMinor: php(40_000) },
    ],
    limits: DEFAULT_LIMITS,
  },
  {
    // The only minor in the fixture: exists so age-dependent rules have a
    // subject to reject.
    kind: 'individual',
    displayName: 'Abigail Lim',
    firstName: 'Abigail',
    lastName: 'Lim',
    dateOfBirth: '2015-09-05',
    identities: [
      {
        subject: 'seed-abigail-lim',
        username: 'abigail.lim',
        email: 'abigail.lim@example.com',
        mobileNumber: '09170000104',
      },
    ],
    accounts: [
      { accountNumber: '1000000004', openingBalanceMinor: php('1999.99') },
    ],
    limits: DEFAULT_LIMITS,
  },
  {
    kind: 'corporate',
    displayName: 'Montenegro Industries',
    legalName: 'Montenegro Industries, Inc.',
    registrationNumber: 'CS201900001',
    signatories: ['Arturo Montenegro', 'Miggy Montenegro'],
    identities: [
      {
        subject: 'seed-arturo-montenegro',
        username: 'arturo.montenegro',
        email: 'arturo.montenegro@montenegro-industries.example.com',
        mobileNumber: '09170000201',
        signatoryName: 'Arturo Montenegro',
      },
      {
        subject: 'seed-miggy-montenegro',
        username: 'miggy.montenegro',
        email: 'miggy.montenegro@montenegro-industries.example.com',
        mobileNumber: '09170000202',
        signatoryName: 'Miggy Montenegro',
      },
    ],
    accounts: [
      { accountNumber: '2000000001', openingBalanceMinor: php(750_000) },
    ],
    limits: DEFAULT_LIMITS,
  },
  {
    kind: 'corporate',
    displayName: 'Lim Aviation Services',
    legalName: 'Lim Aviation Services Corporation',
    registrationNumber: 'CS201900002',
    signatories: ['Richard Lim'],
    identities: [
      {
        subject: 'seed-richard-lim',
        username: 'richard.lim',
        email: 'richard.lim@lim-aviation.example.com',
        mobileNumber: '09170000203',
        signatoryName: 'Richard Lim',
      },
    ],
    accounts: [
      { accountNumber: '2000000002', openingBalanceMinor: php(500_000) },
    ],
    limits: DEFAULT_LIMITS,
  },
];

/**
 * Tables the fixture writes, in reverse dependency order. `truncate()` and the
 * presence check both key off this list.
 */
const SEEDED_TABLES = [
  'ledger_entries',
  'transfers',
  'outbox_events',
  'account_limits',
  'accounts',
  'auth_identities',
  'corporate_signatories',
  'corporate_holders',
  'individual_holders',
  'account_holders',
];

/**
 * Drops every seeded row and restarts the identity sequences, so a reseed
 * produces the same ids as a fresh database. CASCADE is not needed — the list
 * is already in dependency order — but RESTART IDENTITY is what makes the run
 * repeatable.
 */
export async function truncate(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `TRUNCATE TABLE ${SEEDED_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );
  console.log(`Truncated ${SEEDED_TABLES.length} tables.`);
}

async function insertHolder(
  manager: EntityManager,
  holder: HolderSeed,
): Promise<void> {
  const [{ id: holderId }] = await manager.query(
    `INSERT INTO account_holders (holder_type, display_name)
     VALUES ($1, $2) RETURNING id`,
    [holder.kind, holder.displayName],
  );

  const signatoryIds = new Map<string, number>();

  if (holder.kind === 'individual') {
    await manager.query(
      `INSERT INTO individual_holders
         (account_holder_id, first_name, middle_name, last_name, date_of_birth)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        holderId,
        holder.firstName,
        holder.middleName ?? null,
        holder.lastName,
        holder.dateOfBirth,
      ],
    );
  } else {
    await manager.query(
      `INSERT INTO corporate_holders
         (account_holder_id, legal_name, registration_number)
       VALUES ($1, $2, $3)`,
      [holderId, holder.legalName, holder.registrationNumber],
    );

    for (const fullName of holder.signatories) {
      const [{ id: signatoryId }] = await manager.query(
        `INSERT INTO corporate_signatories (corporate_holder_id, full_name)
         VALUES ($1, $2) RETURNING id`,
        [holderId, fullName],
      );
      signatoryIds.set(fullName, signatoryId);
    }
  }

  for (const identity of holder.identities) {
    // NULL for individuals; the composite FK ties a corporate login to a
    // signatory of this same holder.
    const signatoryId = identity.signatoryName
      ? signatoryIds.get(identity.signatoryName)
      : null;

    if (identity.signatoryName && signatoryId === undefined) {
      throw new Error(
        `Identity ${identity.subject} references unknown signatory "${identity.signatoryName}"`,
      );
    }

    await manager.query(
      `INSERT INTO auth_identities
         (account_holder_id, corporate_signatory_id, subject, mobile_number, username, email)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        holderId,
        signatoryId ?? null,
        identity.subject,
        identity.mobileNumber,
        identity.username,
        identity.email,
      ],
    );
  }

  for (const account of holder.accounts) {
    const [{ id: accountId }] = await manager.query(
      `INSERT INTO accounts (account_holder_id, account_number, balance_minor)
       VALUES ($1, $2, $3) RETURNING id`,
      [holderId, account.accountNumber, account.openingBalanceMinor],
    );

    // The ledger is the source of truth and accounts.balance_minor is a cache
    // of it, so the opening balance is booked as a credit rather than left as a
    // bare column value the ledger cannot account for. transfer_id is NULL:
    // this is an opening adjustment, not a transfer.
    if (account.openingBalanceMinor > 0) {
      await manager.query(
        `INSERT INTO ledger_entries
           (transfer_id, account_id, direction, amount_minor, balance_after_minor)
         VALUES (NULL, $1, 'credit', $2, $2)`,
        [accountId, account.openingBalanceMinor],
      );
    }
  }

  await manager.query(
    `INSERT INTO account_limits
       (account_holder_id, daily_limit_minor, monthly_limit_minor)
     VALUES ($1, $2, $3)`,
    [holderId, holder.limits.dailyLimitMinor, holder.limits.monthlyLimitMinor],
  );
}

export async function seed(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => {
    const existing = await manager.query(
      `SELECT id FROM auth_identities WHERE subject = $1`,
      [SEED_MARKER_SUBJECT],
    );
    if (existing.length > 0) {
      console.log(
        'Seed data already present; skipping. Use --reset to reseed.',
      );
      return;
    }

    for (const holder of HOLDER_SEEDS) {
      await insertHolder(manager, holder);
    }

    const identityCount = HOLDER_SEEDS.reduce(
      (total, holder) => total + holder.identities.length,
      0,
    );
    console.log(
      `Seeded ${HOLDER_SEEDS.length} holders and ${identityCount} identities with accounts and limits.`,
    );
  });
}
