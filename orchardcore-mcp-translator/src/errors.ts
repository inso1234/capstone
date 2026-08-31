export class OrchardCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class OrchardCoreAuthError extends OrchardCoreError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class OrchardCoreForbiddenError extends OrchardCoreError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class OrchardCoreValidationError extends OrchardCoreError {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string[]>,
  ) {
    super(message);
  }
}

export class OrchardCoreGraphQLError extends OrchardCoreError {
  constructor(
    message: string,
    readonly graphQLErrors: string[],
  ) {
    super(message);
  }
}

export class OrchardCoreHttpError extends OrchardCoreError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class OrchardCoreNetworkError extends OrchardCoreError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidInputError extends OrchardCoreError {
  constructor(message: string) {
    super(message);
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ContentTypeNotAllowedError extends OrchardCoreError {
  constructor(
    readonly requestedType: string,
    readonly allowedTypes: readonly string[],
  ) {
    super(
      `Content type "${requestedType}" is not allowed. Allowed types: ${allowedTypes.join(", ")}`,
    );
  }
}

export function isOrchardCoreError(err: unknown): err is OrchardCoreError {
  return err instanceof OrchardCoreError;
}
