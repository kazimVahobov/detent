// A mistake in how a command was called: reported in one line, exit code 2.
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}
