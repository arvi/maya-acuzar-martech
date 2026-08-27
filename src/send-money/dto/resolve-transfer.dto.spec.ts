import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ResolveTransferDto } from './resolve-transfer.dto';

function validate(payload: unknown) {
  const dto = plainToInstance(ResolveTransferDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

const base = {
  recipient: { type: 'username', value: 'ethan.delrosario' },
  amount: '1500.00',
};

describe('ResolveTransferDto', () => {
  it('accepts a peso string and normalises it to centavos', () => {
    const { dto, errors } = validate(base);

    expect(errors).toHaveLength(0);
    expect(dto.resolvedAmountMinor()).toBe(150_000);
  });

  it('accepts centavos directly', () => {
    const { dto, errors } = validate({
      recipient: base.recipient,
      amountMinor: 150_000,
    });

    expect(errors).toHaveLength(0);
    expect(dto.resolvedAmountMinor()).toBe(150_000);
  });

  it('rejects a body with neither amount', () => {
    const { errors } = validate({ recipient: base.recipient });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects more than two decimal places rather than rounding', () => {
    const { errors } = validate({ ...base, amount: '10.005' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a mobile number that is not a PH mobile', () => {
    const { errors } = validate({
      ...base,
      recipient: { type: 'mobileNumber', value: '12345' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid PH mobile', () => {
    const { errors } = validate({
      ...base,
      recipient: { type: 'mobileNumber', value: '09170000102' },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a note longer than 100 characters', () => {
    const { errors } = validate({ ...base, note: 'x'.repeat(101) });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown recipient type', () => {
    const { errors } = validate({
      ...base,
      recipient: { type: 'accountId', value: 'anything' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
