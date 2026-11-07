import { Module } from '@nestjs/common';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [BranchesController, UsersController],
  providers: [BranchesService, UsersService],
})
export class AdminModule {}
