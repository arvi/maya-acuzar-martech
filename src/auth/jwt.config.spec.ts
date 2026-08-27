import { isProduction, jwtConfig } from './jwt.config';

describe('jwtConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('falls back to dev secrets outside production', () => {
    process.env.NODE_ENV = 'demo';
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_RESOLUTION_SECRET;

    const config = jwtConfig();

    expect(config.accessSecret).toBeTruthy();
    expect(config.resolutionSecret).toBeTruthy();
    expect(config.accessSecret).not.toEqual(config.resolutionSecret);
  });

  it('refuses to start in production without secrets', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_ACCESS_SECRET;

    expect(() => jwtConfig()).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects reusing one secret for both token types', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'same-secret-value';
    process.env.JWT_RESOLUTION_SECRET = 'same-secret-value';

    expect(() => jwtConfig()).toThrow(/must differ/);
  });

  it('treats only the exact string "production" as production', () => {
    process.env.NODE_ENV = 'demo';
    expect(isProduction()).toBe(false);

    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
  });
});
