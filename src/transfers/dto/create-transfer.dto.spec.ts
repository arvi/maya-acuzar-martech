import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTransferDto } from './create-transfer.dto';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const DESTINATION = '22222222-2222-4222-8222-222222222222';

function validate(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateTransferDto, {
    sourceAccountId: SOURCE,
    destinationAccountId: DESTINATION,
    ...body,
  });
  const errors = validateSync(dto);
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
  return { dto, errors, messages };
}

describe('CreateTransferDto amount fields', () => {
  describe('amount (pesos)', () => {
    it.each([
      ['100.23', 10_023],
      ['0.01', 1],
      ['19.99', 1_999],
      ['100', 10_000],
      ['100.5', 10_050],
    ])('accepts "%s" as %i centavos', (amount, expected) => {
      const { dto, errors } = validate({ amount });
      expect(errors).toHaveLength(0);
      expect(dto.resolvedAmountMinor()).toBe(expected);
    });

    it('accepts a JSON number', () => {
      const { dto, errors } = validate({ amount: 100.23 });
      expect(errors).toHaveLength(0);
      expect(dto.resolvedAmountMinor()).toBe(10_023);
    });

    it.each(['100.235', '0.001', '1e2', '1,234.56', 'abc'])(
      'rejects "%s"',
      (amount) => {
        expect(validate({ amount }).errors.length).toBeGreaterThan(0);
      },
    );

    it('rejects zero and negatives', () => {
      expect(validate({ amount: '0' }).errors.length).toBeGreaterThan(0);
      expect(validate({ amount: '-100.23' }).errors.length).toBeGreaterThan(0);
    });
  });

  describe('amountMinor (centavos)', () => {
    it('accepts a positive integer', () => {
      const { dto, errors } = validate({ amountMinor: 10_023 });
      expect(errors).toHaveLength(0);
      expect(dto.resolvedAmountMinor()).toBe(10_023);
    });

    it('rejects a fractional centavo', () => {
      expect(validate({ amountMinor: 10_023.5 }).errors.length).toBeGreaterThan(
        0,
      );
    });

    it('rejects zero and negatives', () => {
      expect(validate({ amountMinor: 0 }).errors.length).toBeGreaterThan(0);
      expect(validate({ amountMinor: -1 }).errors.length).toBeGreaterThan(0);
    });
  });

  describe('the two fields together', () => {
    it('accepts both when they agree', () => {
      const { dto, errors } = validate({
        amount: '100.23',
        amountMinor: 10_023,
      });
      expect(errors).toHaveLength(0);
      expect(dto.resolvedAmountMinor()).toBe(10_023);
    });

    it('rejects both when they disagree', () => {
      const { messages } = validate({ amount: '100.23', amountMinor: 9_999 });
      expect(messages.join(' ')).toMatch(/must be the same amount/);
    });

    /**
     * Regression: the pair constraint originally sat on `amount`, where
     * @IsOptional() caused class-validator to skip every decorator on the
     * property when it was absent. A body with no amount at all reached the
     * service and produced a 500 instead of a 400.
     */
    it.each([
      ['neither field', {}],
      ['amount: null', { amount: null }],
      ['amountMinor: null', { amountMinor: null }],
      ['both null', { amount: null, amountMinor: null }],
    ])('rejects a body with %s', (_label, body) => {
      const { messages } = validate(body);
      expect(messages.join(' ')).toMatch(/Provide an amount/);
    });

    it('throws rather than returning undefined if never validated', () => {
      const unvalidated = plainToInstance(CreateTransferDto, {
        sourceAccountId: SOURCE,
        destinationAccountId: DESTINATION,
      });
      expect(() => unvalidated.resolvedAmountMinor()).toThrow(
        /was not validated/,
      );
    });
  });
});
