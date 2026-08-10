import type { DashboardProjection } from "../domain/models";

export interface DashboardQueryPort {
  getDashboard(): Promise<DashboardProjection>;
}

export class DashboardUseCases {
  constructor(private readonly query: DashboardQueryPort) {}

  getDashboard() {
    return this.query.getDashboard();
  }
}
