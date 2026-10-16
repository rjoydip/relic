import { userService } from "../services/user";

interface ResolveArgs {
  id: string;
  data: { name?: string };
}

export const resolvers = {
  Mutation: {
    updateUser: async (_: unknown, args: ResolveArgs): Promise<boolean> => {
      await userService.updateUser(args.id, args.data);
      return true;
    },
  },
};
