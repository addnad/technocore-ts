/** Raised when input or server data violates the Technocore protocol. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** The room already has too many copies of this text. Rephrase and retry. */
export class DuplicateError extends Error {
  constructor(
    message: string,
    /** The ref token from the 422 body — send as &ref= on next requests. */
    readonly ref?: string,
  ) {
    super(message);
    this.name = "DuplicateError";
  }
}
