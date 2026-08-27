import { InvalidMoneyAmountError, minorToPesos, pesosToMinor } from './money';

describe('pesosToMinor', () => {
  it.each([
    ['100', 10_000],
    ['100.2', 10_020],
    ['100.23', 10_023],
    ['0.01', 1],
    ['0.10', 10],
    ['0.1', 10],
    ['0', 0],
    ['50000.00', 5_000_000],
    ['1234.56', 123_456],
  ])('parses "%s" as %i centavos', (input, expected) => {
    expect(pesosToMinor(input)).toBe(expected);
  });

  it('accepts numbers as well as strings', () => {
    expect(pesosToMinor(100.23)).toBe(10_023);
    expect(pesosToMinor(1)).toBe(100);
  });

  /**
   * The reason this module exists: `19.99 * 100` is 1998.9999999999998 and
   * `100.235 * 100` is 10023.499999999998. Truncating either loses a centavo.
   */
  it.each([
    ['19.99', 1_999],
    ['0.29', 29],
    ['1.15', 115],
    ['8.87', 887],
    ['1.005', null], // 3dp — rejected, never silently rounded
  ])('is exact for float-hostile value "%s"', (input, expected) => {
    if (expected === null) {
      expect(() => pesosToMinor(input)).toThrow(InvalidMoneyAmountError);
    } else {
      expect(pesosToMinor(input)).toBe(expected);
    }
  });

  it.each([
    '100.235',
    '100.2345',
    '0.001',
    '1e2',
    '1E2',
    '.5',
    '1,234.56',
    'abc',
    '',
    ' ',
    'NaN',
    'Infinity',
  ])('rejects "%s"', (input) => {
    expect(() => pesosToMinor(input)).toThrow(InvalidMoneyAmountError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => pesosToMinor(Number.NaN)).toThrow(InvalidMoneyAmountError);
    expect(() => pesosToMinor(Number.POSITIVE_INFINITY)).toThrow(
      InvalidMoneyAmountError,
    );
  });

  it('rejects amounts too large to hold exactly', () => {
    expect(() => pesosToMinor('999999999999999999')).toThrow(
      InvalidMoneyAmountError,
    );
  });

  it('handles negatives (used for reversals, not for API input)', () => {
    expect(pesosToMinor('-100.23')).toBe(-10_023);
  });
});

describe('minorToPesos', () => {
  it.each([
    [10_023, '100.23'],
    [1, '0.01'],
    [10, '0.10'],
    [0, '0.00'],
    [100, '1.00'],
    [5_000_000, '50000.00'],
    [123_456, '1234.56'],
    [-10_023, '-100.23'],
  ])('formats %i as "%s"', (input, expected) => {
    expect(minorToPesos(input)).toBe(expected);
  });

  it('rejects a non-integer centavo amount', () => {
    expect(() => minorToPesos(10_023.5)).toThrow(InvalidMoneyAmountError);
  });
});

describe('round trip', () => {
  it.each([
    '0.01',
    '0.99',
    '1.00',
    '19.99',
    '100.23',
    '1234.56',
    '50000.00',
    '85000.00',
  ])('%s survives pesos -> centavos -> pesos', (pesos) => {
    expect(minorToPesos(pesosToMinor(pesos))).toBe(pesos);
  });
});
