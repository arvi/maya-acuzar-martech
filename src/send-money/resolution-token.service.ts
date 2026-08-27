import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtConfig } from '../auth/jwt.config';

export const RESOLUTION_TOKEN_TYPE = 'send_money_resolution';

/**
 * What phase one tells phase two.
 *
 * src and dst are internal sequential account ids. They are safe here — and
 * only here — because the token is signed by the server, opaque to the client
 * and lives two minutes. They never appear in a request or a response body.
 */
export interface ResolutionClaims {
  typ: typeof RESOLUTION_TOKEN_TYPE;
  /** auth_identities.id of the sender this token was issued to. */
  aid: number;
  src: number;
  dst: number;
  amt: number;
  note: string | null;
  jti: string;
}

export type ResolutionInput = Omit<ResolutionClaims, 'typ' | 'jti'>;

/**
 * The token is a hint, not an authorisation. Phase two re-runs every rule
 * inside the write transaction; this only saves a resolution round-trip and
 * carries the note. That is why no quote table is needed — the idempotency key
 * is the replay guard and the rules are the authority.
 */
@Injectable()
export class ResolutionTokenService {
  constructor(private readonly jwt: JwtService) {}

  async sign(
    input: ResolutionInput,
  ): Promise<{ token: string; expiresAt: Date }> {
    const config = jwtConfig();

    const token = await this.jwt.signAsync(
      { typ: RESOLUTION_TOKEN_TYPE, ...input, jti: randomUUID() },
      {
        secret: config.resolutionSecret,
        expiresIn: config.resolutionTtlSeconds,
      },
    );

    return {
      token,
      expiresAt: new Date(Date.now() + config.resolutionTtlSeconds * 1000),
    };
  }

  async verify(
    token: string,
    authIdentityId: number,
  ): Promise<ResolutionClaims> {
    const config = jwtConfig();
    let claims: ResolutionClaims;

    try {
      claims = await this.jwt.verifyAsync<ResolutionClaims>(token, {
        secret: config.resolutionSecret,
      });
    } catch (error) {
      const expired =
        error instanceof Error && error.name === 'TokenExpiredError';

      // A distinct code, so the client knows to re-resolve rather than
      // surfacing this as a generic failure the user cannot act on.
      throw new ForbiddenException({
        code: expired ? 'RESOLUTION_TOKEN_EXPIRED' : 'RESOLUTION_TOKEN_INVALID',
        message: expired
          ? 'This confirmation has expired. Please confirm the transfer again.'
          : 'Resolution token is not valid.',
      });
    }

    if (claims.typ !== RESOLUTION_TOKEN_TYPE) {
      throw new ForbiddenException({
        code: 'RESOLUTION_TOKEN_INVALID',
        message: 'Resolution token is not valid.',
      });
    }

    // Binds the token to the identity that asked for it: whoever intercepts a
    // token cannot spend it.
    if (claims.aid !== authIdentityId) {
      throw new ForbiddenException({
        code: 'RESOLUTION_TOKEN_IDENTITY_MISMATCH',
        message: 'This confirmation was issued to a different account.',
      });
    }

    return claims;
  }
}
