export class NativeInputError extends Error {
  constructor(message, seatStatus = null, invalid = false) {
    super(message);
    this.seatStatus = seatStatus;
    this.invalid = invalid;
  }
}

export class NativeTransportError extends Error {
  constructor(error) {
    super(String(error?.message ?? error), {cause: error});
  }
}
