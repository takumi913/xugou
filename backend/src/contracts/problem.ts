export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  code: string;
  trace_id: string;
  detail?: string;
  errors?: Record<string, string[]>;
}
