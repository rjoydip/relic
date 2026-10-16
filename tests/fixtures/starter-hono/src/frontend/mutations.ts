export interface MutationSpec {
  operation: string;
  label: string;
}

export function defineMutation(spec: MutationSpec): MutationSpec {
  return spec;
}

export const updateUserMutation = defineMutation({
  operation: "PATCH /users/:id",
  label: "Update user",
});
