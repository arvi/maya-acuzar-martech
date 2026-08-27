import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AccountsService } from './accounts.service';
import { AccountLimitResponseDto } from './dto/account-limit-response.dto';
import { AccountResponseDto } from './dto/account-response.dto';

@ApiTags('Accounts')
@Controller({ path: 'accounts', version: '1' })
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get(':publicId')
  @ApiOperation({ summary: 'Fetch an account and its cached balance' })
  @ApiParam({
    name: 'publicId',
    format: 'uuid',
    description: 'The account public_id, not its internal sequential id.',
  })
  @ApiOkResponse({ type: AccountResponseDto })
  @ApiNotFoundResponse({ description: 'No account with that public id.' })
  getAccount(
    @Param(
      'publicId',
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }),
    )
    publicId: string,
  ): Promise<AccountResponseDto> {
    return this.accountsService.getAccount(publicId);
  }

  @Get(':publicId/limits')
  @ApiOperation({
    summary: 'Fetch send-money limits and current usage',
    description:
      'Limits belong to the account holder and apply across every account they own, so the usage returned here spans all of them.',
  })
  @ApiParam({ name: 'publicId', format: 'uuid' })
  @ApiOkResponse({ type: AccountLimitResponseDto })
  @ApiNotFoundResponse({
    description: 'No such account, or no limits configured for its holder.',
  })
  getLimits(
    @Param(
      'publicId',
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }),
    )
    publicId: string,
  ): Promise<AccountLimitResponseDto> {
    return this.accountsService.getLimits(publicId);
  }
}
