import { z } from "zod";

export const authCredentialsSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

export const adminProfileUpdateSchema = z
  .object({
    email: z.string().trim().email().max(254).nullable(),
  })
  .strict();

export const adminPasswordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(6).max(256),
  })
  .strict();

export function legacyBadRequest(message: string) {
  return { success: false, message };
}
