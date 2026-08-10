export class ApplicationProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    detail?: string,
    readonly errors?: Record<string, string[]>
  ) {
    super(detail ?? title);
    this.name = "ApplicationProblem";
  }
}
