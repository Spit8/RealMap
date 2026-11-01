/**
 * A message computed away from the UI (worker, core): an i18n key and its parameters, translated
 * where it is shown (`tm` in `lib/i18n`), so a reason or an origin follows the language picker.
 * A parameter may itself be a message (a reason inside a reason).
 */
export interface Msg {
  key: string;
  params?: Record<string, string | number | Msg>;
}

export function msg(key: string, params?: Msg["params"]): Msg {
  return params ? { key, params } : { key };
}

/** An error whose text is an i18n message (download and service errors). */
export class MsgError extends Error {
  constructor(public msg: Msg) {
    super(msg.key);
  }
}
