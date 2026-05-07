// Local shim. Replaces upstream src/util/logger.ts which depends on the
// openclaw plugin host. Forwards to the project's electron-log wrapper.
//
// Vendored files import `{ logger }` and call only info/debug/warn/error.

import { createLogger } from "../../../../utils/logger";

export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

const inner = createLogger("WeChat");

export const logger: Logger = {
  info: (m) => inner.info(m),
  debug: (m) => inner.debug(m),
  warn: (m) => inner.warn(m),
  error: (m) => inner.error(m),
};
