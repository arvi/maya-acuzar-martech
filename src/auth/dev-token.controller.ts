import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { Public } from './decorators/public.decorator';
import { DevTokenService } from './dev-token.service';
import { DevTokenRequestDto } from './dto/dev-token-request.dto';
import { DevTokenResponseDto } from './dto/dev-token-response.dto';

@ApiTags('Dev')
@Controller({ path: 'dev', version: '1' })
export class DevTokenController {
  constructor(private readonly devTokenService: DevTokenService) {}

  @Post('token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Access token issued.')
  @ApiOperation({
    summary: 'Mint an access token for a seeded identity (non-production only)',
    description:
      'Stands in for a Keycloak token endpoint. Returns a token whose claims mimic Keycloak, for use as `Authorization: Bearer <token>` on every other endpoint.\n\n' +
      'Seeded usernames: `adelaida.magtalas`, `ethan.delrosario`, `joy.fabregas`, `abigail.lim`, `arturo.montenegro`, `miggy.montenegro`, `richard.lim`, `bobbie.salazar` (suspended).\n\n' +
      'A token is issued for a suspended holder too — the guard rejects it on use, which is how the suspended-sender case is exercised.',
  })
  @ApiOkResponse({ type: DevTokenResponseDto })
  @ApiNotFoundResponse({ description: 'No identity with that username.' })
  mint(@Body() dto: DevTokenRequestDto): Promise<DevTokenResponseDto> {
    return this.devTokenService.mint(dto.username);
  }
}
