import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { AuthIdentity } from '../holders/entities/auth-identity.entity';
import { DevTokenService } from './dev-token.service';

describe('DevTokenService', () => {
  let service: DevTokenService;
  let repository: { findOne: jest.Mock };

  const identity = {
    id: 1,
    subject: 'seed-adelaida-magtalas',
    username: 'adelaida.magtalas',
    email: 'adelaida.magtalas@example.com',
  } as AuthIdentity;

  beforeEach(() => {
    repository = { findOne: jest.fn().mockResolvedValue(identity) };
    service = new DevTokenService(
      repository as unknown as Repository<AuthIdentity>,
      new JwtService(),
    );
  });

  it('mints a Keycloak-shaped token for a seeded identity', async () => {
    const result = await service.mint('adelaida.magtalas');

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 3600,
      subject: 'seed-adelaida-magtalas',
    });

    const claims = JSON.parse(
      Buffer.from(result.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      sub: 'seed-adelaida-magtalas',
      preferred_username: 'adelaida.magtalas',
      realm_access: { roles: ['user'] },
    });
    expect(claims.iss).toContain('realms');
  });

  it('mints for a suspended holder too — the guard is what rejects them', async () => {
    // Deliberate: the sender-suspended scenario needs a token it can present.
    await expect(service.mint('bobbie.salazar')).resolves.toBeDefined();
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { username: 'bobbie.salazar' },
    });
  });

  it('404s for an unknown username', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(service.mint('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
