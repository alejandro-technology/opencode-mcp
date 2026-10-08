export type PromptDispatchOutcome =
  | { state: "accepted" }
  | { state: "rejected"; status: number; error: string }
  | { state: "uncertain"; status?: number; error: string };

function responseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("response" in value)) return undefined;
  const response = value.response;
  if (typeof response !== "object" || response === null || !("status" in response))
    return undefined;
  return typeof response.status === "number" ? response.status : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

export async function sendPromptAndClassify(
  dispatch: () => Promise<unknown>,
): Promise<PromptDispatchOutcome> {
  try {
    const response = await dispatch();
    if (
      typeof response !== "object" ||
      response === null ||
      !("error" in response) ||
      !response.error
    )
      return { state: "accepted" };

    const status = responseStatus(response);
    const error = errorMessage(response.error);
    if (status !== undefined && status >= 400 && status < 500)
      return { state: "rejected", status, error };
    return { state: "uncertain", ...(status === undefined ? {} : { status }), error };
  } catch (error) {
    return { state: "uncertain", error: errorMessage(error) };
  }
}
