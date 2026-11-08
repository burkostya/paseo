import { z } from "zod";
export const workingCopyOptions = z
  .object({
    version: z.literal(1),
    data: z
      .object({
        name: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
      })
      .strict(),
  })
  .strict();
