export interface ReviewState {
  [key: string]: string;
}
export class ReviewStore {
  constructor(
    private state: ReviewState,
    private save: (state: ReviewState) => PromiseLike<void>,
  ) {}
  private key(root: string, scope: string, file: string) {
    return JSON.stringify([root, scope, file]);
  }
  has(root: string, scope: string, file: string) {
    return !!this.state[this.key(root, scope, file)];
  }
  matches(root: string, scope: string, file: string, fingerprint: string) {
    return this.state[this.key(root, scope, file)] === fingerprint;
  }
  async toggle(root: string, scope: string, file: string, fingerprint: string) {
    const key = this.key(root, scope, file);
    if (this.state[key] === fingerprint) delete this.state[key];
    else this.state[key] = fingerprint;
    await this.save({ ...this.state });
    return !!this.state[key];
  }
}
