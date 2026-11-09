import { type AuthUser, CurrentUser, Roles } from '@jewelry/common';
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { DlqService } from './dlq.service';

/** Gateway ánh xạ /api/admin/reports/dlq; backend bắt buộc ADMIN cho cả xem và replay. */
@Controller('admin/dlq')
@Roles('ADMIN')
export class DlqController {
  constructor(private readonly dlq: DlqService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.dlq.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.dlq.detail(id);
  }

  @Post(':id/replay')
  replay(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dlq.replay(id, user.id);
  }
}
