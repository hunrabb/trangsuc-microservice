import { BuybackAppraisalController } from './buyback-appraisal.controller';
import { BuybackSettlementController } from './buyback-settlement.controller';
import { BuybackSettlementService } from './buyback-settlement.service';
import { BuybackSettlementRecoveryWorker } from './buyback-settlement-recovery.worker';
import { ExchangeClient } from './exchange-client';
import { BuybackAppraisalService } from './buyback-appraisal.service';
import { BuybackPriceClient } from './buyback-price.client';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BuybacksController } from './buybacks.controller';
import { BuybacksService } from './buybacks.service';

@Module({
  imports: [PrismaModule],
  controllers: [BuybackAppraisalController, BuybackSettlementController, BuybacksController],
  providers: [
    BuybacksService,
    BuybackAppraisalService,
    BuybackPriceClient,
    BuybackSettlementService,
    BuybackSettlementRecoveryWorker,
    ExchangeClient,
  ],
})
export class BuybacksModule {}
