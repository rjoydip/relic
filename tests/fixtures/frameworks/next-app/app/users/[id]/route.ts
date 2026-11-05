// @ts-nocheck
export async function GET(_request: Request, context: { params: { id: string } }) {
  return Response.json({ id: context.params.id });
}

export async function POST(request: Request) {
  return Response.json(await request.json());
}
