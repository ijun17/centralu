

/** The mock's clock and its one counter for the ids it makes (`mock-session-3`, `mock-view-4`…) */
export class MockClock {
  private idc = 0
  now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  next(): number {
    return ++this.idc
  }

  get id(): number {
    return this.idc
  }
}
