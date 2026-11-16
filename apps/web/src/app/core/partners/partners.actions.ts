/**
 * Builder partner disclosure actions (#918). One request per session: the
 * state ignores `LoadPartners` while a request is in flight or once the
 * list has loaded; a failed request is not cached, so the next capture
 * point retries.
 */
export class LoadPartners {
  static readonly type = '[Partners] Load';
}
