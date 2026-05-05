export class Mutex {
  private held = false;
  private queue: Array<(release: () => void) => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        this.held = false;
        const next = this.queue.shift();
        if (next) {
          this.held = true;
          next(release);
        }
      };
      if (this.held) {
        this.queue.push(resolve);
      } else {
        this.held = true;
        resolve(release);
      }
    });
  }

  tryAcquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    return () => {
      this.held = false;
      const next = this.queue.shift();
      if (next) {
        this.held = true;
        next(
          this.tryAcquire() ??
            (() => {
              this.held = false;
            }),
        );
      }
    };
  }
}
