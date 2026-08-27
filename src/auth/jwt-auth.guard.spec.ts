import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { jwtConfig } from './jwt.config';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextFor(
  headers: Record<string, string>,
  request: Record<string, unknown> = {},
) {
  const req = { headers, ...request };
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => req }),
    __req: req,
  } as unknown as ExecutionContext & { __req: Record<string, unknown> };
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwt: JwtService;
  let dataSource: { query: jest.Mock };

  const activeRow = {
    id: '1',
    account_holder_id: '1',
    subject: 'seed-adelaida-magtalas',
    username: 'adelaida.magtalas',
    display_name: 'Adelaida Magtalas',
    holder_status: 'active',
  };

  async function tokenFor(
    subject: string,
    overrides: Record<string, unknown> = {},
  ) {
    const config = jwtConfig();
    return jwt.signAsync(
      { preferred_username: 'adelaida.magtalas', ...overrides },
      {
        secret: config.accessSecret,
        subject,
        issuer: config.issuer,
        expiresIn: config.accessTtlSeconds,
      },
    );
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jwt = new JwtService();
    dataSource = { query: jest.fn().mockResolvedValue([activeRow]) };
    guard = new JwtAuthGuard(
      new Reflector(),
      jwt,
      dataSource as unknown as DataSource,
    );
  });

  it('attaches the identity for a valid token', async () => {
    const token = await tokenFor('seed-adelaida-magtalas');
    const context = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(
      (context as never as { __req: { identity: unknown } }).__req.identity,
    ).toEqual({
      authIdentityId: 1,
      accountHolderId: 1,
      subject: 'seed-adelaida-magtalas',
      username: 'adelaida.magtalas',
      displayName: 'Adelaida Magtalas',
      holderStatus: 'active',
    });
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong key', async () => {
    const forged = await jwt.signAsync(
      { sub: 'seed-adelaida-magtalas' },
      { secret: 'not-the-access-secret', expiresIn: 60 },
    );

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${forged}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token with a distinct code', async () => {
    const config = jwtConfig();
    const expired = await jwt.signAsync(
      { preferred_username: 'x' },
      {
        secret: config.accessSecret,
        subject: 'seed-adelaida-magtalas',
        issuer: config.issuer,
        expiresIn: -10,
      },
    );

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${expired}` })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    });
  });

  it('403s a suspended holder', async () => {
    dataSource.query.mockResolvedValue([
      { ...activeRow, holder_status: 'suspended' },
    ]);
    const token = await tokenFor('seed-bobbie-salazar');

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('401s when the identity behind a valid token is gone', async () => {
    dataSource.query.mockResolvedValue([]);
    const token = await tokenFor('seed-deleted');

    await expect(
      guard.canActivate(contextFor({ authorization: `Bearer ${token}` })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDENTITY_NOT_FOUND' }),
    });
  });

  it('lets a @Public() route through untouched', async () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    guard = new JwtAuthGuard(
      reflector,
      jwt,
      dataSource as unknown as DataSource,
    );

    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
