import type { Bindings } from "../../models/db";
import { StatusUseCases } from "./application/StatusUseCases";
import { D1StatusRepository } from "./persistence/D1StatusRepository";

export function createStatusUseCases(env: Bindings) {
  return new StatusUseCases(new D1StatusRepository(env));
}
