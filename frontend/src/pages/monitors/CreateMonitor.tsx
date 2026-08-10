import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { createMonitor, type MonitorMutation } from "@/api/monitors";
import MonitorForm, {
  emptyMonitorFormValues,
} from "@/features/monitors/MonitorForm";

export default function CreateMonitor() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: createMonitor,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["monitors"] });
      navigate("/monitors");
    },
    onError: () => alert(t("monitor.form.createFailed")),
  });

  const submit = async (input: MonitorMutation) => {
    try {
      await mutation.mutateAsync(input);
    } catch {
      // Mutation state and the localized alert carry the recoverable error.
    }
  };

  return (
    <MonitorForm
      title={t("monitor.form.title.create")}
      values={emptyMonitorFormValues}
      submitLabel={t("monitor.form.create")}
      submittingLabel={t("monitor.form.creating")}
      submitting={mutation.isPending}
      onSubmit={submit}
      onCancel={() => navigate("/monitors")}
    />
  );
}
