

/** The mock's clock and its one counter for the ids it makes (`mock-session-3`, `mock-view-4`…) */
export class MockClock {
  private idc = 0
  now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  /** The next id number — every kind of id in the mock draws on this one counter */
  next(): number {
    return ++this.idc
  }

  /** The id number last handed out */
  get id(): number {
    return this.idc
  }
}
