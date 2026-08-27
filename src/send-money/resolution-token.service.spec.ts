import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtConfig } from '../auth/jwt.config';
import { ResolutionTokenService } from './resolution-token.service';

describe('ResolutionTokenService', () => {
  let service: ResolutionTokenService;
  let jwt: JwtService;

  const claims = { aid: 1, src: 1, dst: 2, amt: 150_000, note: 'Lunch' };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jwt = new JwtService();
    service = new ResolutionTokenService(jwt);
  });

  it('round-trips the claims, note included', async () => {
    const { token } = await service.sign(claims);

    await expect(service.verify(token, 1)).resolves.toMatchObject({
      typ: 'send_money_resolution',
      aid: 1,
      src: 1,
      dst: 2,
      amt: 150_000,
      note: 'Lunch',
    });
  });

  it('reports expiry with a code the client can act on', async () => {
    process.env.JWT_RESOLUTION_TTL_SECONDS = '1';

    const { token } = await service.sign(claims);

    // Wait for token to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(service.verify(token, 1)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'RESOLUTION_TOKEN_EXPIRED',
      }),
    });

    delete process.env.JWT_RESOLUTION_TTL_SECONDS;
  }, 5000);

  it('rejects a token signed with the access secret', async () => {
    // The two secrets are separate precisely so this fails.
    const config = jwtConfig();
    const wrongKey = await jwt.signAsync(
      { typ: 'send_money_resolution', ...claims, jti: 'x' },
      { secret: config.accessSecret, expiresIn: 120 },
    );

    await expect(service.verify(wrongKey, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a token whose typ is not a resolution token', async () => {
    const config = jwtConfig();
    const wrongType = await jwt.signAsync(
      { typ: 'something_else', ...claims, jti: 'x' },
      { secret: config.resolutionSecret, expiresIn: 120 },
    );

    await expect(service.verify(wrongType, 1)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RESOLUTION_TOKEN_INVALID' }),
    });
  });

  it('refuses a token spent by a different identity', async () => {
    const { token } = await service.sign(claims);

    await expect(service.verify(token, 99)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'RESOLUTION_TOKEN_IDENTITY_MISMATCH',
      }),
    });
  });

  it('gives every token a distinct jti', async () => {
    const a = await service.sign(claims);
    const b = await service.sign(claims);

    const [first, second] = await Promise.all([
      service.verify(a.token, 1),
      service.verify(b.token, 1),
    ]);

    expect(first.jti).not.toEqual(second.jti);
  });
});
