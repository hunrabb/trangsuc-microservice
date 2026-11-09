import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BuybacksController } from './buybacks.controller';
import { BuybacksService } from './buybacks.service';

@Module({
  imports: [PrismaModule],
  controllers: [BuybacksController],
  providers: [BuybacksService],
})
export class BuybacksModule {}
