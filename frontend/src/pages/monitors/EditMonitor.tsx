import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import {
  getMonitor,
  updateMonitor,
  type MonitorMutation,
} from "@/api/monitors";
import { Button, Card } from "@/components/ui";
import PageLoading from "@/components/PageLoading";
import MonitorForm, {
  type MonitorFormValues,
} from "@/features/monitors/MonitorForm";

export default function EditMonitor() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const monitorId = Number(id);
  const validId = Number.isInteger(monitorId) && monitorId > 0;
  const query = useQuery({
    queryKey: ["monitors", "detail", monitorId],
    queryFn: ({ signal }) => getMonitor(monitorId, signal),
    enabled: validId,
  });
  const values = useMemo<MonitorFormValues | null>(() => {
    const monitor = query.data;
    if (!monitor) return null;
    const headers = Object.entries(monitor.headers).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : String(value ?? ""),
    }));
    return {
      name: monitor.name,
      url: monitor.url,
      method: monitor.method as MonitorFormValues["method"],
      intervalMinutes: Math.max(
        1,
        Math.round(monitor.interval_seconds / 60)
      ),
      timeoutSeconds: monitor.timeout_ms / 1000,
      expectedStatus: monitor.expected_status,
      headers: headers.length > 0 ? headers : [{ key: "", value: "" }],
      body: monitor.body ?? "",
    };
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: (input: MonitorMutation) => updateMonitor(monitorId, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["monitors"] }),
        queryClient.invalidateQueries({
          queryKey: ["monitors", "detail", monitorId],
        }),
      ]);
      navigate(`/monitors/${monitorId}`);
    },
    onError: () => alert(t("monitor.form.updateFailed")),
  });

  if (query.isPending) return <PageLoading />;

  if (!validId || query.error || !values) {
    return (
      <div className="flex justify-center p-6">
        <Card className="space-y-4 p-4 text-center">
          <h1 className="text-xl font-semibold">{t("monitor.notExist")}</h1>
          <p>
            {query.error instanceof Error
              ? query.error.message
              : t("common.error.fetch")}
          </p>
          <Button onClick={() => navigate("/monitors")}>
            {t("monitor.returnToList")}
          </Button>
        </Card>
      </div>
    );
  }

  const submit = async (input: MonitorMutation) => {
    try {
      await mutation.mutateAsync(input);
    } catch {
      // Mutation state and the localized alert carry the recoverable error.
    }
  };

  return (
    <MonitorForm
      title={`${t("monitor.form.title.edit")}: ${values.name}`}
      values={values}
      submitLabel={t("common.saveChanges")}
      submittingLabel={t("common.savingChanges")}
      submitting={mutation.isPending}
      onSubmit={submit}
      onCancel={() => navigate(`/monitors/${monitorId}`)}
    />
  );
}
