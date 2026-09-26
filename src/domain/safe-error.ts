// Cloud logs are long-lived and may be exported. Never log raw provider error
// bodies, request URLs, transcript excerpts, render arguments or API keys.
export function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[a-z][a-z0-9_:-]{0,63}$/i.test(message) ? message : "unclassified_error";
}
