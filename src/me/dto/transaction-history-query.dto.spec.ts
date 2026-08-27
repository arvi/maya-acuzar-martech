import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TransactionHistoryQueryDto } from './transaction-history-query.dto';

const validate = (query: Record<string, unknown>) =>
  validateSync(plainToInstance(TransactionHistoryQueryDto, query));

const failedProperties = (query: Record<string, unknown>) =>
  validate(query).map((error) => error.property);

describe('TransactionHistoryQueryDto', () => {
  it('accepts an absent range', () => {
    expect(validate({})).toHaveLength(0);
  });

  it('accepts either bound alone', () => {
    expect(validate({ from: '2026-08-01' })).toHaveLength(0);
    expect(validate({ to: '2026-08-27' })).toHaveLength(0);
  });

  it('accepts an ordered range, including a single day', () => {
    expect(validate({ from: '2026-08-01', to: '2026-08-27' })).toHaveLength(0);
    expect(validate({ from: '2026-08-27', to: '2026-08-27' })).toHaveLength(0);
  });

  it('rejects a malformed date', () => {
    expect(failedProperties({ from: '01-08-2026' })).toContain('from');
    expect(failedProperties({ from: '2026-8-1' })).toContain('from');
    expect(failedProperties({ to: 'yesterday' })).toContain('to');
  });

  it('rejects a date that does not exist', () => {
    // Postgres would raise 22008 for these, surfacing a 500 for what is
    // really a bad request.
    expect(failedProperties({ from: '2026-02-30' })).toContain('from');
    expect(failedProperties({ from: '2026-13-01' })).toContain('from');
    expect(failedProperties({ to: '2026-04-31' })).toContain('to');
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(validate({ from: '2024-02-29' })).toHaveLength(0);
    expect(failedProperties({ from: '2026-02-29' })).toContain('from');
  });

  it('rejects an inverted range', () => {
    expect(
      failedProperties({ from: '2026-08-27', to: '2026-08-01' }),
    ).toContain('to');
  });
});
