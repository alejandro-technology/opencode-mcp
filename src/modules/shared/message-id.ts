import { randomUUID } from "node:crypto";

/** OpenCode 1.18.x requires caller-supplied message IDs to use its msg_ namespace. */
export function createMessageId(): string {
  return `msg_${randomUUID()}`;
}
