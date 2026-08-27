import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1787796874604 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // --- extensions + shared trigger function -----
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION set_updated_at()
            RETURNS TRIGGER
            LANGUAGE plpgsql
            AS $$
            BEGIN
                -- Skip no-op updates so updated_at reflects real changes. Compared minus
                -- updated_at itself, otherwise every row would always look different.
                IF to_jsonb(OLD) - 'updated_at' IS NOT DISTINCT FROM to_jsonb(NEW) - 'updated_at' THEN
                    RETURN NEW;
                END IF;

                NEW.updated_at := now();
                RETURN NEW;
            END;
            $$;
        `);

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION reject_mutation()
            RETURNS TRIGGER
            LANGUAGE plpgsql
            AS $$
            BEGIN
                RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
                    USING ERRCODE = 'restrict_violation';
            END;
            $$;
        `);

        // --- account_holders (supertype) -----
        await queryRunner.query(`
            CREATE TABLE account_holders (
                id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                holder_type     TEXT NOT NULL,
                display_name    TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'active',
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT account_holders_holder_type_chk CHECK (holder_type IN ('individual', 'corporate')),
                CONSTRAINT account_holders_status_chk      CHECK (status IN ('active', 'suspended', 'closed')),
                CONSTRAINT account_holders_type_uq         UNIQUE (id, holder_type)
            );
        `);

        // --- individual_holders (subtype, shared PK = 1:1) -----
        await queryRunner.query(`
            CREATE TABLE individual_holders (
                account_holder_id       BIGINT PRIMARY KEY REFERENCES account_holders(id) ON DELETE RESTRICT,
                holder_type             TEXT NOT NULL GENERATED ALWAYS AS ('individual') STORED,
                first_name              TEXT NOT NULL,
                middle_name             TEXT,
                last_name               TEXT NOT NULL,
                date_of_birth           DATE NOT NULL,
                created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT individual_holders_supertype_fk
                    FOREIGN KEY (account_holder_id, holder_type)
                    REFERENCES account_holders(id, holder_type) ON DELETE RESTRICT
            );

            COMMENT ON COLUMN individual_holders.middle_name IS 'NULL = holder has no middle name on record';
            COMMENT ON COLUMN individual_holders.holder_type IS 'Always ''individual''; exists so the FK to account_holders(id, holder_type) blocks subtype/supertype mismatch';
        `);

        // --- corporate_holders (subtype, shared PK = 1:1) -----
        await queryRunner.query(`
            CREATE TABLE corporate_holders (
                account_holder_id       BIGINT PRIMARY KEY REFERENCES account_holders(id) ON DELETE RESTRICT,
                holder_type             TEXT NOT NULL GENERATED ALWAYS AS ('corporate') STORED,
                legal_name              TEXT NOT NULL,
                registration_number     TEXT,
                created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT corporate_holders_supertype_fk
                    FOREIGN KEY (account_holder_id, holder_type)
                    REFERENCES account_holders(id, holder_type) ON DELETE RESTRICT
            );

            COMMENT ON COLUMN corporate_holders.registration_number IS 'NULL = holder has no SEC/registration number on record';
            COMMENT ON COLUMN corporate_holders.holder_type         IS 'Always ''corporate''; exists so the FK to account_holders(id, holder_type) blocks subtype/supertype mismatch';
        `);

        // --- corporate_signatories -----
        await queryRunner.query(`
            CREATE TABLE corporate_signatories (
                id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                corporate_holder_id     BIGINT NOT NULL REFERENCES corporate_holders(account_holder_id) ON DELETE RESTRICT,
                full_name               TEXT NOT NULL,
                created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT corporate_signatories_holder_uq UNIQUE (id, corporate_holder_id)
            );

            COMMENT ON CONSTRAINT corporate_signatories_holder_uq ON corporate_signatories IS 'Redundant on its own; exists as the FK target that ties an auth_identity signatory to the same holder';
        `);

        // --- auth_identities -----
        await queryRunner.query(`
            CREATE TABLE auth_identities (
                id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                account_holder_id      BIGINT NOT NULL REFERENCES account_holders(id) ON DELETE RESTRICT,
                corporate_signatory_id BIGINT,
                subject                TEXT NOT NULL,
                mobile_number          TEXT NOT NULL,
                username               TEXT NOT NULL,
                email                  TEXT NOT NULL,
                created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT auth_identities_subject_uq  UNIQUE (subject),
                CONSTRAINT auth_identities_mobile_uq   UNIQUE (mobile_number),
                CONSTRAINT auth_identities_username_uq UNIQUE (username),
                CONSTRAINT auth_identities_email_uq    UNIQUE (email),
                CONSTRAINT auth_identities_signatory_holder_fk
                    FOREIGN KEY (corporate_signatory_id, account_holder_id)
                    REFERENCES corporate_signatories(id, corporate_holder_id) ON DELETE RESTRICT
            );
            COMMENT ON COLUMN auth_identities.subject                IS 'Keycloak JWT "sub" claim; stable per identity';
            COMMENT ON COLUMN auth_identities.mobile_number          IS 'PH mobile (09XXXXXXXXX); login credential';
            COMMENT ON COLUMN auth_identities.corporate_signatory_id IS 'NULL = identity is an individual holder, not a corporate signatory login. When set, the composite FK forces the signatory to belong to this same account_holder_id; MATCH SIMPLE means a NULL here skips that check, which is the intended individual-holder case.';
        `);

        // --- accounts -----
        await queryRunner.query(`
            CREATE TABLE accounts (
                id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                public_id           UUID NOT NULL DEFAULT gen_random_uuid(),
                account_holder_id   BIGINT NOT NULL REFERENCES account_holders(id) ON DELETE RESTRICT,
                account_number      TEXT,
                currency            CHAR(3) NOT NULL DEFAULT 'PHP',
                balance_minor       BIGINT NOT NULL DEFAULT 0,
                status              TEXT NOT NULL DEFAULT 'active',
                created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT accounts_currency_chk CHECK (currency = 'PHP'),
                CONSTRAINT accounts_status_chk   CHECK (status IN ('active', 'suspended', 'closed')),
                CONSTRAINT accounts_balance_not_negative_chk CHECK (balance_minor >= 0)
            );

            COMMENT ON COLUMN accounts.balance_minor    IS 'Cached balance in PHP centavos (minor units); source of truth is ledger_entries';
            COMMENT ON COLUMN accounts.account_number   IS 'NULL = account has no account number on record; send money without using account number';
            COMMENT ON COLUMN accounts.public_id        IS 'Opaque external identifier; expose this over the API, never the sequential id';
        `);

        // --- account_limits ----
        await queryRunner.query(`
            CREATE TABLE account_limits (
                id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                account_holder_id   BIGINT NOT NULL REFERENCES account_holders(id) ON DELETE RESTRICT,
                currency            CHAR(3) NOT NULL DEFAULT 'PHP',
                daily_limit_minor   BIGINT NOT NULL,
                monthly_limit_minor BIGINT NOT NULL,
                created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT account_limits_holder_uq    UNIQUE (account_holder_id),
                CONSTRAINT account_limits_currency_chk CHECK (currency = 'PHP'),
                CONSTRAINT account_limits_daily_chk    CHECK (daily_limit_minor  >= 0),
                CONSTRAINT account_limits_monthly_chk  CHECK (monthly_limit_minor >= 0),
                CONSTRAINT account_limits_period_chk   CHECK (monthly_limit_minor >= daily_limit_minor)
            );

            COMMENT ON TABLE  account_limits                     IS 'Limits are per account_holder, applying across every account the holder owns; usage must be summed across all of them';
            COMMENT ON COLUMN account_limits.daily_limit_minor   IS 'Max outbound per day in PHP centavos (minor units)';
            COMMENT ON COLUMN account_limits.monthly_limit_minor IS 'Max outbound per month in PHP centavos (minor units)';
        `);

        // --- transfers ----------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE transfers (
                id                            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                public_id                     UUID NOT NULL DEFAULT gen_random_uuid(),
                source_account_id             BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
                destination_account_id        BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
                amount_minor                  BIGINT NOT NULL,
                currency                      CHAR(3) NOT NULL DEFAULT 'PHP',
                status                        TEXT NOT NULL DEFAULT 'pending',
                idempotency_key               TEXT,
                initiated_by_auth_identity_id BIGINT REFERENCES auth_identities(id) ON DELETE RESTRICT,
                failure_reason                TEXT,
                posted_at                     TIMESTAMPTZ,
                created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT transfers_amount_pos_chk        CHECK (amount_minor > 0),
                CONSTRAINT transfers_currency_chk          CHECK (currency = 'PHP'),
                CONSTRAINT transfers_status_chk            CHECK (status IN ('pending','posted','failed','reversed')),
                CONSTRAINT transfers_distinct_accounts_chk CHECK (source_account_id <> destination_account_id)
            );

            COMMENT ON COLUMN transfers.public_id                     IS 'Opaque external identifier; expose this over the API, never the sequential id';
            COMMENT ON COLUMN transfers.idempotency_key               IS 'NULL = request made without an idempotency key; uniqueness is scoped per initiating identity, not global';
            COMMENT ON COLUMN transfers.initiated_by_auth_identity_id IS 'NULL = system/automated transfer with no user identity e.g system-generated, reversals';
            COMMENT ON COLUMN transfers.failure_reason                IS 'NULL = transfer has not failed';
            COMMENT ON COLUMN transfers.posted_at                     IS 'NULL = not yet posted to the ledger';
        `);

        // --- ledger_entries (append-only (immutable), double-entry) ------------------------
        await queryRunner.query(`
            CREATE TABLE ledger_entries (
                id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                transfer_id         BIGINT REFERENCES transfers(id) ON DELETE RESTRICT,
                account_id          BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
                direction           TEXT NOT NULL,
                amount_minor        BIGINT NOT NULL,
                currency            CHAR(3) NOT NULL DEFAULT 'PHP',
                balance_after_minor BIGINT,
                posted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT ledger_entries_direction_chk  CHECK (direction IN ('debit','credit')),
                CONSTRAINT ledger_entries_amount_pos_chk CHECK (amount_minor > 0),
                CONSTRAINT ledger_entries_currency_chk   CHECK (currency = 'PHP')
            );

            COMMENT ON TABLE  ledger_entries                     IS 'Append-only double-entry ledger; UPDATE/DELETE are rejected by trigger. Corrections are made with a compensating reversal pair, never by mutating a row. No updated_at by design: on an immutable table its only valid value equals created_at, and it would falsely imply mutation is supported.';
            COMMENT ON COLUMN ledger_entries.transfer_id         IS 'NULL = manual adjustment/fee not tied to a transfer';
            COMMENT ON COLUMN ledger_entries.balance_after_minor IS 'NULL = running balance snapshot not computed at write time';
        `);

        // --- outbox_events (transactional outbox) ------------------------------
        await queryRunner.query(`
            CREATE TABLE outbox_events (
                id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                aggregate_type TEXT NOT NULL,
                aggregate_id   BIGINT,
                event_type     TEXT NOT NULL,
                payload        JSONB NOT NULL,
                status         TEXT NOT NULL DEFAULT 'pending',
                attempts       INTEGER NOT NULL DEFAULT 0,
                published_at   TIMESTAMPTZ,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT outbox_events_status_chk CHECK (status IN ('pending','published','failed'))
            );

            COMMENT ON COLUMN outbox_events.aggregate_id IS 'NULL = event not associated with a specific aggregate row';
            COMMENT ON COLUMN outbox_events.published_at IS 'NULL = event not yet published to the broker';
        `);

        // --- updated_at triggers (fire only when the row actually changes) -----
        // ledger_entries is deliberately absent: it is append-only and has no updated_at.
        const mutableTables = [
            'account_holders',
            'individual_holders',
            'corporate_holders',
            'corporate_signatories',
            'auth_identities',
            'accounts',
            'account_limits',
            'transfers',
            'outbox_events',
        ];

        // Keep the no-op check inside the function. Whole-row comparisons do not work
        // with generated columns, but to_jsonb handles these tables safely.
        for (const t of mutableTables) {
            await queryRunner.query(`
                CREATE TRIGGER trg_${t}_set_updated_at
                BEFORE UPDATE ON ${t}
                FOR EACH ROW
                EXECUTE FUNCTION set_updated_at();
            `);
        }

        // --- append-only enforcement -------------------------------------------
        // The trigger is the backstop; the REVOKE is the actual control for the app role.
        await queryRunner.query(`
            CREATE TRIGGER trg_ledger_entries_immutable
            BEFORE UPDATE OR DELETE ON ledger_entries
            FOR EACH ROW
            EXECUTE FUNCTION reject_mutation();
        `);

        // --- indexes ------------------------------------------------------------
        await queryRunner.query(`
            CREATE INDEX idx_corporate_signatories_holder ON corporate_signatories (corporate_holder_id);
            CREATE INDEX idx_auth_identities_holder       ON auth_identities (account_holder_id);
            CREATE INDEX idx_auth_identities_signatory    ON auth_identities (corporate_signatory_id);
            CREATE INDEX idx_accounts_holder              ON accounts (account_holder_id);
            CREATE UNIQUE INDEX uq_accounts_public_id     ON accounts (public_id);
            CREATE UNIQUE INDEX uq_accounts_number        ON accounts (account_number) WHERE account_number IS NOT NULL;
            CREATE INDEX idx_transfers_source             ON transfers (source_account_id);
            CREATE INDEX idx_transfers_destination        ON transfers (destination_account_id);
            CREATE INDEX idx_transfers_status             ON transfers (status);
            CREATE INDEX idx_transfers_initiator          ON transfers (initiated_by_auth_identity_id);
            CREATE UNIQUE INDEX uq_transfers_public_id    ON transfers (public_id);

            -- Idempotency is scoped per initiating identity so one caller's key cannot
            -- collide with another's. Rows with no initiator are system transfers.
            CREATE UNIQUE INDEX uq_transfers_idempotency
                ON transfers (initiated_by_auth_identity_id, idempotency_key)
                WHERE idempotency_key IS NOT NULL;

            -- Serves both limit-usage sums and per-account transaction history.
            CREATE INDEX idx_ledger_entries_account_posted ON ledger_entries (account_id, posted_at DESC);
            CREATE INDEX idx_ledger_entries_transfer       ON ledger_entries (transfer_id);

            -- A transfer can post at most one debit and one credit: makes double-posting
            -- impossible at the database level rather than by application discipline.
            CREATE UNIQUE INDEX uq_ledger_entries_transfer_direction
                ON ledger_entries (transfer_id, direction)
                WHERE transfer_id IS NOT NULL;

            CREATE INDEX idx_outbox_pending               ON outbox_events (created_at) WHERE status = 'pending';
        `);
    }

    // For migration:revert; ON DELETE RESTRICT is irrelevant to DROP TABLE
    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse dependency order. Triggers and indexes are dropped implicitly with their tables
        const tables = [
            'outbox_events',
            'ledger_entries',
            'transfers',
            'account_limits',
            'accounts',
            'auth_identities',
            'corporate_signatories',
            'corporate_holders',
            'individual_holders',
            'account_holders',
        ];
        for (const t of tables) {
            await queryRunner.query(`DROP TABLE IF EXISTS ${t};`);
        }

        // Standalone functions need explicit cleanup.
        await queryRunner.query(`DROP FUNCTION IF EXISTS reject_mutation();`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS set_updated_at();`);

        // pgcrypto is intentionally left installed: it may predate this migration or be shared with other schemas
    }
}
