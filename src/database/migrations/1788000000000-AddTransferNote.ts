import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTransferNote1788000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // On transfers rather than ledger_entries: a note describes the transfer as
    // a whole, not one leg of the double-entry pair. Putting it on entries would
    // duplicate the same text across the debit and the credit.
    await queryRunner.query(`
      ALTER TABLE transfers ADD COLUMN note TEXT;

      ALTER TABLE transfers ADD CONSTRAINT transfers_note_len_chk
        CHECK (note IS NULL OR char_length(note) <= 100);

      COMMENT ON COLUMN transfers.note IS
        'NULL = sender attached no note. Max 100 chars, enforced by transfers_note_len_chk.';
    `);

    // The limits were documented as outbound-only. They now bound each
    // direction independently against the same numbers: outbound debits for the
    // sender, inbound credits for the recipient.
    await queryRunner.query(`
      COMMENT ON COLUMN account_limits.daily_limit_minor IS
        'Max per day in PHP centavos, applied per direction: outbound debits for a sender, inbound credits for a recipient. Usage counts only ledger entries tied to a transfer.';

      COMMENT ON COLUMN account_limits.monthly_limit_minor IS
        'Max per month in PHP centavos, applied per direction: outbound debits for a sender, inbound credits for a recipient. Usage counts only ledger entries tied to a transfer.';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_note_len_chk;
      ALTER TABLE transfers DROP COLUMN IF EXISTS note;

      COMMENT ON COLUMN account_limits.daily_limit_minor   IS 'Max outbound per day in PHP centavos (minor units)';
      COMMENT ON COLUMN account_limits.monthly_limit_minor IS 'Max outbound per month in PHP centavos (minor units)';
    `);
  }
}
