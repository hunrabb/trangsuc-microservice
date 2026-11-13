import { CurrentUser, Roles, ZodValidationPipe, type AuthUser } from '@jewelry/common';
import {
  appraisalInputSchema,
  buybackQuoteInputSchema,
  buybackDecisionSchema,
  rejectBuybackQuoteSchema,
  createBuybackPolicySchema,
  updateBuybackPolicySchema,
  idempotencyKeySchema,
  type AppraisalInput,
  type BuybackQuoteInput,
  type CreateBuybackPolicy,
  type UpdateBuybackPolicy,
} from '@jewelry/contracts';
import {
  Body,
  Controller,
  Get,
  Put,
  Post,
  Param,
  ParseUUIDPipe,
  Headers,
  Header,
  HttpCode,
} from '@nestjs/common';
import { BuybackAppraisalService } from './buyback-appraisal.service';
const key = (input: unknown) => new ZodValidationPipe(idempotencyKeySchema).transform(input);

@Roles('ADMIN', 'MANAGER', 'STAFF')
@Controller('admin/branches/:branchId/buybacks')
export class BuybackAppraisalController {
  constructor(private readonly appraisals: BuybackAppraisalService) {}
  @Get('price-policies')
  @Header('Cache-Control', 'no-store')
  policies(@CurrentUser() u: AuthUser, @Param('branchId', new ParseUUIDPipe()) b: string) {
    return this.appraisals.policies(u, b);
  }
  @Post('price-policies')
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  createPolicy(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(createBuybackPolicySchema)) body: CreateBuybackPolicy,
  ) {
    return this.appraisals.createPolicy(u, b, key(k), body);
  }
  @Put('price-policies/:policyId')
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  updatePolicy(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('policyId', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateBuybackPolicySchema)) body: UpdateBuybackPolicy,
  ) {
    return this.appraisals.updatePolicy(u, b, id, body);
  }
  @Get(':id/appraisals')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.appraisals.appraisals(u, b, id);
  }
  @Put(':id/items/:itemId/appraisal')
  @Header('Cache-Control', 'no-store')
  appraise(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(appraisalInputSchema)) body: AppraisalInput,
  ) {
    return this.appraisals.appraise(u, b, id, itemId, key(k), body);
  }
  @Post(':id/quotes')
  @Header('Cache-Control', 'no-store')
  quote(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(buybackQuoteInputSchema)) body: BuybackQuoteInput,
  ) {
    return this.appraisals.quote(u, b, id, key(k), body);
  }
  @Get(':id/quotes')
  @Header('Cache-Control', 'no-store')
  quotes(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.appraisals.quotes(u, b, id);
  }
  @Post(':id/quotes/:quoteId/approve')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  approve(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('quoteId', new ParseUUIDPipe()) q: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(buybackDecisionSchema)) body: { version: number },
  ) {
    return this.appraisals.decide(u, b, id, q, key(k), body, true);
  }
  @Post(':id/quotes/:quoteId/reject')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reject(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('quoteId', new ParseUUIDPipe()) q: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(rejectBuybackQuoteSchema))
    body: { version: number; reason: string },
  ) {
    return this.appraisals.decide(u, b, id, q, key(k), body, false);
  }
}
