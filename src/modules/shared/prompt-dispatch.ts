export type PromptDispatchOutcome =
  | { state: "accepted"; response?: unknown }
  | { state: "rejected"; status: number; error: string }
  | { state: "uncertain"; status?: number; error: string };

function responseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("response" in value) {
    const response = value.response;
    if (typeof response === "object" && response !== null && "status" in response) {
      if (typeof response.status === "number") return response.status;
    }
  }
  if ("cause" in value) {
    const cause = value.cause;
    if (typeof cause === "object" && cause !== null && "status" in cause) {
      if (typeof cause.status === "number") return cause.status;
    }
  }
  return undefined;
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
      return typeof response === "object" && response !== null && "id" in response
        ? { state: "accepted", response }
        : { state: "accepted" };

    const status = responseStatus(response);
    const error = errorMessage(response.error);
    if (status !== undefined && status >= 400 && status < 500)
      return { state: "rejected", status, error };
    return { state: "uncertain", ...(status === undefined ? {} : { status }), error };
  } catch (error) {
    const status = responseStatus(error);
    const message = errorMessage(error);
    if (status !== undefined && status >= 400 && status < 500)
      return { state: "rejected", status, error: message };
    return { state: "uncertain", ...(status === undefined ? {} : { status }), error: message };
  }
}
