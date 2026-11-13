import { Public } from '@jewelry/common';
import { Controller, Get, Header, Param, ParseUUIDPipe } from '@nestjs/common';
import { MetalsService } from './metals.service';

/** Internal-only read; Gateway blocks /internal. No stock mutation or sale-price fallback. */
@Public()
@Controller('internal/buyback-prices')
export class InternalBuybackPriceController {
  constructor(private readonly metals: MetalsService) {}
  @Get(':metalId')
  @Header('Cache-Control', 'no-store')
  get(@Param('metalId', new ParseUUIDPipe()) id: string) {
    return this.metals.buybackPrice(id);
  }
}
