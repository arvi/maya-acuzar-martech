import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class DevTokenRequestDto {
  @ApiProperty({
    description: 'Username of a seeded identity.',
    example: 'adelaida.magtalas',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username: string;
}
