import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { useTranslation } from "react-i18next";
import type { AgentUpdate } from "@/api/agents";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@/components/ui";
import { BILLING_CYCLES, BILLING_CYCLE_KEYS } from "@/utils/billing";
import {
  agentFormSchema,
  agentFormToUpdate,
  type AgentFormValues,
} from "./form-contract";
export {
  agentFormSchema,
  agentFormToUpdate,
  type AgentFormValues,
} from "./form-contract";

interface AgentFormProps {
  values: AgentFormValues;
  submitting: boolean;
  onSubmit: (update: AgentUpdate) => Promise<void>;
  onCancel: () => void;
}

const TRAFFIC_CALC_TYPES = ["sum", "rx", "tx"] as const;
const TRAFFIC_CALC_TYPE_KEYS = {
  sum: "agent.traffic.calc.sum",
  rx: "agent.traffic.calc.rx",
  tx: "agent.traffic.calc.tx",
} as const;

export default function AgentForm({
  values,
  submitting,
  onSubmit,
  onCancel,
}: AgentFormProps) {
  const { t } = useTranslation();
  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: values,
    mode: "onBlur",
  });

  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty || submitting) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [isDirty, submitting]);

  const cancel = () => {
    if (isDirty && !window.confirm(t("agent.form.discardChanges"))) return;
    onCancel();
  };
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="sm:px-6 lg:px-[8%]">
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" onClick={cancel}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="prompt-title">
          {t("agent.form.editingClient", { name: values.name })}
        </h1>
      </div>
      <div className="terminal-card mt-4 p-4">
        <form
          noValidate
          className="space-y-4"
          onSubmit={handleSubmit(async (formValues) => {
            await onSubmit(agentFormToUpdate(formValues));
          })}
        >
          {hasErrors && (
            <p className="rounded-md border border-destructive p-3 text-sm text-destructive" role="alert">
              {t("agent.form.validationError")}
            </p>
          )}

          <div>
            <label htmlFor="agent-name" className="mb-1 block text-sm font-medium">
              {t("agent.form.name")} *
            </label>
            <Input
              id="agent-name"
              aria-invalid={Boolean(errors.name)}
              placeholder={t("agent.form.namePlaceholder")}
              {...register("name")}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("agent.form.nameHelp")}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="collect-interval" className="mb-1 block text-sm font-medium">
                {t("agent.form.collectInterval")}
              </label>
              <Input
                id="collect-interval"
                type="number"
                min="1"
                max="86400"
                aria-invalid={Boolean(errors.collectIntervalSeconds)}
                {...register("collectIntervalSeconds")}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("agent.form.collectIntervalHelp")}
              </p>
            </div>
            <div>
              <label htmlFor="report-interval" className="mb-1 block text-sm font-medium">
                {t("agent.form.reportInterval")}
              </label>
              <Input
                id="report-interval"
                type="number"
                min="1"
                max="86400"
                aria-invalid={Boolean(errors.reportIntervalSeconds)}
                {...register("reportIntervalSeconds")}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("agent.form.reportIntervalHelp")}
              </p>
            </div>
          </div>

          <Controller
            control={control}
            name="autoUpdate"
            render={({ field }) => (
              <SwitchField
                label={t("agent.form.autoUpdate")}
                help={t("agent.form.autoUpdateHelp")}
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />

          <SectionTitle>{t("agent.form.groupSection")}</SectionTitle>
          <div>
            <label htmlFor="agent-group" className="mb-1 block text-sm font-medium">
              {t("agent.form.groupName")}
            </label>
            <Input
              id="agent-group"
              maxLength={64}
              placeholder={t("agent.form.groupNamePlaceholder")}
              {...register("groupName")}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("agent.form.groupNameHelp")}
            </p>
          </div>
          <div>
            <label htmlFor="agent-tags" className="mb-1 block text-sm font-medium">
              {t("agent.form.tags")}
            </label>
            <Input
              id="agent-tags"
              aria-invalid={Boolean(errors.tags)}
              placeholder="web, prod, hk"
              {...register("tags")}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("agent.form.tagsHelp")}
            </p>
          </div>

          <SectionTitle>{t("agent.form.billingSection")}</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
            <div>
              <label htmlFor="agent-price" className="mb-1 block text-sm font-medium">
                {t("agent.form.price")}
              </label>
              <Input
                id="agent-price"
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                aria-invalid={Boolean(errors.price)}
                placeholder="9.99"
                {...register("price")}
              />
            </div>
            <div>
              <label htmlFor="agent-currency" className="mb-1 block text-sm font-medium">
                {t("agent.form.currency")}
              </label>
              <Input
                id="agent-currency"
                maxLength={16}
                placeholder="USD"
                {...register("currency")}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("agent.form.billingCycle")}
            </label>
            <Controller
              control={control}
              name="billingCycle"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label={t("agent.form.billingCycle")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("agent.billing.cycle.none")}
                    </SelectItem>
                    {BILLING_CYCLES.map((cycle) => (
                      <SelectItem key={cycle} value={cycle}>
                        {t(BILLING_CYCLE_KEYS[cycle])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div>
            <label htmlFor="agent-expire-date" className="mb-1 block text-sm font-medium">
              {t("agent.form.expireDate")}
            </label>
            <Input id="agent-expire-date" type="date" {...register("expireDate")} />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("agent.form.expireDateHelp")}
            </p>
          </div>
          <Controller
            control={control}
            name="autoRenewal"
            render={({ field }) => (
              <SwitchField
                label={t("agent.form.autoRenewal")}
                help={t("agent.form.autoRenewalHelp")}
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />

          <SectionTitle>{t("agent.form.trafficSection")}</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
            <div>
              <label htmlFor="traffic-limit" className="mb-1 block text-sm font-medium">
                {t("agent.form.trafficLimit")}
              </label>
              <Input
                id="traffic-limit"
                type="number"
                min="0.1"
                max="1000000000"
                step="0.1"
                aria-invalid={Boolean(errors.trafficLimitGb)}
                placeholder="1024"
                {...register("trafficLimitGb")}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("agent.form.trafficLimitHelp")}
              </p>
            </div>
            <div>
              <label htmlFor="traffic-reset-day" className="mb-1 block text-sm font-medium">
                {t("agent.form.trafficResetDay")}
              </label>
              <Input
                id="traffic-reset-day"
                type="number"
                min="1"
                max="28"
                aria-invalid={Boolean(errors.trafficResetDay)}
                {...register("trafficResetDay")}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("agent.form.trafficResetDayHelp")}
              </p>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("agent.form.trafficCalcType")}
            </label>
            <Controller
              control={control}
              name="trafficCalcType"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label={t("agent.form.trafficCalcType")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRAFFIC_CALC_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(TRAFFIC_CALC_TYPE_KEYS[type])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <SectionTitle>{t("agent.form.visibilitySection")}</SectionTitle>
          <Controller
            control={control}
            name="isHidden"
            render={({ field }) => (
              <SwitchField
                label={t("agent.form.hideFromStatusPage")}
                help={t("agent.form.hideFromStatusPageHelp")}
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={cancel}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? t("common.savingChanges")
                : t("common.saveChanges")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="group-title">{children}</h2>;
}

function SwitchField({
  label,
  help,
  checked,
  onCheckedChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{help}</p>
    </div>
  );
}
