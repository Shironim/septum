/** One mutation/parse lane per server; failures do not poison later work. */
export class SerialWorkQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result.then(() => {}, () => {}).finally(() => {
      this.pending--;
      if (this.pending === 0) {
        this.tail = Promise.resolve();
      }
    });
    return result;
  }
  drain(): Promise<void> { return this.tail; }
}
