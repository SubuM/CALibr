export class RepositoryError extends Error {}
export class NotFoundError extends RepositoryError {}
export class InsufficientCopiesError extends RepositoryError {}
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}