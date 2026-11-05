// @ts-nocheck
import { initTRPC } from "@trpc/server";

const t = initTRPC.create();
const publicProcedure = t.procedure;

export const appRouter = t.router({
  getUser: publicProcedure.query(() => ({ id: "1" })),
  updateUser: publicProcedure.mutation(({ input }: { input: { id: string } }) => ({
    id: input.id,
  })),
});
