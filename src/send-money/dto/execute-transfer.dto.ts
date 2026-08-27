import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ExecuteTransferDto {
  @ApiProperty({
    description:
      'The `resolutionToken` returned by POST /v1/send-money/resolve. Valid for 120 seconds.',
  })
  @IsString()
  @MinLength(1)
  resolutionToken: string;
}
