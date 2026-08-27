import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthIdentity } from '../holders/entities/auth-identity.entity';
import { DevTokenResponseDto } from './dto/dev-token-response.dto';
import { jwtConfig } from './jwt.config';

/**
 * Stands in for a Keycloak token endpoint so the flow can be driven without
 * running an identity provider. Registered only outside production — see
 * AuthModule.
 */
@Injectable()
export class DevTokenService {
  constructor(
    @InjectRepository(AuthIdentity)
    private readonly identities: Repository<AuthIdentity>,
    private readonly jwt: JwtService,
  ) {}

  async mint(username: string): Promise<DevTokenResponseDto> {
    const identity = await this.identities.findOne({ where: { username } });

    if (!identity) {
      throw new NotFoundException({
        code: 'IDENTITY_NOT_FOUND',
        message: `No identity with username "${username}".`,
      });
    }

    // Holder status is deliberately not checked here. Minting a token for a
    // suspended holder is how the suspended-sender path is exercised; the
    // guard is what rejects it, which is also where a real IdP-issued token
    // for a since-suspended user would be caught.
    const config = jwtConfig();

    const accessToken = await this.jwt.signAsync(
      {
        preferred_username: identity.username,
        email: identity.email,
        realm_access: { roles: ['user'] },
      },
      {
        secret: config.accessSecret,
        subject: identity.subject,
        issuer: config.issuer,
        expiresIn: config.accessTtlSeconds,
      },
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: config.accessTtlSeconds,
      subject: identity.subject,
    };
  }
}
