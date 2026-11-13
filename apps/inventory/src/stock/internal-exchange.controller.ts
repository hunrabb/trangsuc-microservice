import { Public, ZodValidationPipe } from '@jewelry/common';
import {
  reserveExchangeSchema,
  exchangeReleaseSchema,
  type ReserveExchange,
} from '@jewelry/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, HttpCode } from '@nestjs/common';
import { ExchangeHoldsService } from './exchange-holds.service';

@Public()
@Controller('internal/exchanges')
export class InternalExchangeController {
  constructor(private readonly holds: ExchangeHoldsService) {}
  @Post('reserve')
  @HttpCode(200)
  reserve(@Body(new ZodValidationPipe(reserveExchangeSchema)) body: ReserveExchange) {
    return this.holds.reserve(body);
  }
  @Get(':id')
  state(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.holds.state(id);
  }
  @Post(':id/protect')
  @HttpCode(200)
  protect(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.holds.protect(id);
  }
  @Post(':id/consume')
  @HttpCode(200)
  consume(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.holds.consume(id);
  }
  @Post('release')
  @HttpCode(200)
  release(@Body(new ZodValidationPipe(exchangeReleaseSchema)) body: { exchangeId: string }) {
    return this.holds.release(body.exchangeId);
  }
}
