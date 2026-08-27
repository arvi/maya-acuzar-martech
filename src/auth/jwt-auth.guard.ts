import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { AuthenticatedIdentity } from './identity.types';
import { jwtConfig } from './jwt.config';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = extractBearer(request.headers?.authorization);

    if (!token) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN',
        message: 'Send an access token as `Authorization: Bearer <token>`.',
      });
    }

    const config = jwtConfig();
    let subject: string;

    try {
      const claims = await this.jwt.verifyAsync(token, {
        secret: config.accessSecret,
        issuer: config.issuer,
      });
      subject = claims.sub;
    } catch (error) {
      const expired =
        error instanceof Error && error.name === 'TokenExpiredError';

      throw new UnauthorizedException({
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired
          ? 'Access token has expired; request a new one.'
          : 'Access token is not valid.',
      });
    }

    // Resolved on every request rather than trusted from the token, so a token
    // stays usable only as long as the identity behind it does.
    const [row] = await this.dataSource.query(
      `SELECT ai.id, ai.account_holder_id, ai.subject, ai.username,
              h.display_name, h.status AS holder_status
         FROM auth_identities ai
         JOIN account_holders h ON h.id = ai.account_holder_id
        WHERE ai.subject = $1`,
      [subject],
    );

    if (!row) {
      throw new UnauthorizedException({
        code: 'IDENTITY_NOT_FOUND',
        message: 'The identity this token was issued for no longer exists.',
      });
    }

    if (row.holder_status !== 'active') {
      throw new ForbiddenException({
        code: 'IDENTITY_NOT_ACTIVE',
        message: `This account is ${row.holder_status} and cannot transact.`,
        status: row.holder_status,
      });
    }

    const identity: AuthenticatedIdentity = {
      authIdentityId: Number(row.id),
      accountHolderId: Number(row.account_holder_id),
      subject: row.subject,
      username: row.username,
      displayName: row.display_name,
      holderStatus: row.holder_status,
    };

    request.identity = identity;
    return true;
  }
}

function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;

  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
