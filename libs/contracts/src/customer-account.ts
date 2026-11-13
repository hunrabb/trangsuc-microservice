import { z } from 'zod';
import { onlineOrderViewSchema } from './online-checkout';
import { isAcceptablePassword } from './auth-api';
export const customerLoginSchema = z
  .object({
    email: z.email().max(254).toLowerCase(),
    password: z.string().min(1).max(256),
  })
  .strict();
export const customerRegisterSchema = customerLoginSchema.extend({
  fullName: z.string().trim().min(1).max(150),
  password: z.string().refine(isAcceptablePassword),
});
export type CustomerLogin = z.infer<typeof customerLoginSchema>;
export type CustomerRegister = z.infer<typeof customerRegisterSchema>;
export const customerAccountSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  fullName: z.string(),
});
export const customerSessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  user: customerAccountSchema,
});
export type CustomerSession = z.infer<typeof customerSessionSchema>;
export const accountOrderSchema = onlineOrderViewSchema.extend({ createdAt: z.iso.datetime() });
export const accountOrderPageSchema = z.object({
  items: z.array(accountOrderSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
