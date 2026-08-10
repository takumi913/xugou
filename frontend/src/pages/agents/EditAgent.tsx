import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { getAgent, updateAgent, type AgentUpdate } from "@/api/agents";
import { Button, Card } from "@/components/ui";
import PageLoading from "@/components/PageLoading";
import AgentForm, { type AgentFormValues } from "@/features/agents/AgentForm";

export default function EditAgent() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const agentId = Number(id);
  const validId = Number.isInteger(agentId) && agentId > 0;
  const query = useQuery({
    queryKey: ["agents", "detail", agentId],
    queryFn: ({ signal }) => getAgent(agentId, signal),
    enabled: validId,
  });
  const values = useMemo<AgentFormValues | null>(() => {
    const agent = query.data;
    if (!agent) return null;
    return {
      name: agent.name,
      collectIntervalSeconds: String(agent.collect_interval_seconds),
      reportIntervalSeconds: String(agent.report_interval_seconds),
      autoUpdate: agent.auto_update,
      groupName: agent.group_name ?? "",
      tags: agent.tags.join(", "),
      price:
        typeof agent.price === "number" && agent.price >= 0
          ? String(agent.price)
          : "",
      currency: agent.currency ?? "USD",
      billingCycle: (["monthly", "quarterly", "yearly", "once", "none"] as const).find(
        (cycle) => cycle === agent.billing_cycle
      ) ?? "none",
      expireDate: agent.expire_date ?? "",
      autoRenewal: agent.auto_renewal,
      trafficLimitGb:
        typeof agent.traffic_limit_gb === "number" &&
        agent.traffic_limit_gb > 0
          ? String(agent.traffic_limit_gb)
          : "",
      trafficResetDay: String(agent.traffic_reset_day ?? 1),
      trafficCalcType: (["sum", "rx", "tx"] as const).find(
        (calculation) => calculation === agent.traffic_calc_type
      ) ?? "sum",
      isHidden: agent.is_hidden,
    };
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: (input: AgentUpdate) => updateAgent(agentId, input),
    onSuccess: async () => {
      toast.success(t("agent.form.updateSuccess"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
        queryClient.invalidateQueries({
          queryKey: ["agents", "detail", agentId],
        }),
      ]);
      navigate(`/agents/${agentId}`);
    },
    onError: () => toast.error(t("agent.form.updateError")),
  });

  if (query.isPending) return <PageLoading />;

  if (!validId || query.error || !values) {
    return (
      <div className="flex justify-center p-6">
        <Card className="space-y-4 p-4 text-center">
          <h1 className="text-xl font-semibold">{t("agents.notFound")}</h1>
          <p>{t("agents.notFoundId", { id })}</p>
          <Button onClick={() => navigate("/agents")}>
            {t("common.backToList")}
          </Button>
        </Card>
      </div>
    );
  }

  const submit = async (input: AgentUpdate) => {
    try {
      await mutation.mutateAsync(input);
    } catch {
      // Mutation state and toast preserve a recoverable form state.
    }
  };

  return (
    <AgentForm
      values={values}
      submitting={mutation.isPending}
      onSubmit={submit}
      onCancel={() => navigate(`/agents/${agentId}`)}
    />
  );
}
