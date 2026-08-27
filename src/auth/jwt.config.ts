/**
 * Exactly the string 'production' counts as production. Anything else —
 * 'demo', 'development', unset — is a non-production build in which
 * POST /v1/dev/token is registered and secret fallbacks apply.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export interface JwtConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  resolutionSecret: string;
  resolutionTtlSeconds: number;
  issuer: string;
}

const DEV_ACCESS_SECRET = 'dev-only-access-secret-do-not-use-in-production';
const DEV_RESOLUTION_SECRET =
  'dev-only-resolution-secret-do-not-use-in-production';

function requiredInProduction(name: string, fallback: string): string {
  const value = process.env[name];
  if (value) return value;

  if (isProduction()) {
    throw new Error(
      `${name} must be set when NODE_ENV=production. Refusing to start with a well-known development secret.`,
    );
  }

  return fallback;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of seconds.`);
  }

  return value;
}

/**
 * Access tokens and resolution tokens are signed with different keys on
 * purpose. An access token authorises a session; a resolution token authorises
 * one specific movement of money. Sharing a key would let either be presented
 * where the other is expected.
 */
export function jwtConfig(): JwtConfig {
  const accessSecret = requiredInProduction(
    'JWT_ACCESS_SECRET',
    DEV_ACCESS_SECRET,
  );
  const resolutionSecret = requiredInProduction(
    'JWT_RESOLUTION_SECRET',
    DEV_RESOLUTION_SECRET,
  );

  if (accessSecret === resolutionSecret) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_RESOLUTION_SECRET must differ; a shared key lets one token type be presented as the other.',
    );
  }

  return {
    accessSecret,
    resolutionSecret,
    accessTtlSeconds: positiveInt('JWT_ACCESS_TTL_SECONDS', 3600),
    resolutionTtlSeconds: positiveInt('JWT_RESOLUTION_TTL_SECONDS', 120),
    issuer: process.env.JWT_ISSUER ?? 'http://localhost:8080/realms/send-money',
  };
}
