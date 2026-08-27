import { ApiProperty } from '@nestjs/swagger';

export class DevTokenResponseDto {
  @ApiProperty({ description: 'Send as `Authorization: Bearer <token>`.' })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ description: 'Lifetime in seconds.', example: 3600 })
  expiresIn: number;

  @ApiProperty({
    description: 'The Keycloak `sub` claim this token carries.',
    example: 'seed-adelaida-magtalas',
  })
  subject: string;
}
