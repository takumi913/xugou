import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { ArrowLeftIcon, PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { useTranslation } from "react-i18next";
import type { MonitorMutation } from "@/api/monitors";
import StatusCodeSelect from "@/components/StatusCodeSelect";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Textarea,
} from "@/components/ui";
import {
  monitorFormSchema,
  monitorFormToMutation,
  type MonitorFormValues,
} from "./form-contract";
export {
  emptyMonitorFormValues,
  monitorFormSchema,
  monitorFormToMutation,
  type MonitorFormValues,
} from "./form-contract";

interface MonitorFormProps {
  title: string;
  values: MonitorFormValues;
  submitLabel: string;
  submittingLabel: string;
  submitting: boolean;
  onSubmit: (mutation: MonitorMutation) => Promise<void>;
  onCancel: () => void;
}

export default function MonitorForm({
  title,
  values,
  submitLabel,
  submittingLabel,
  submitting,
  onSubmit,
  onCancel,
}: MonitorFormProps) {
  const { t } = useTranslation();
  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<MonitorFormValues>({
    resolver: zodResolver(monitorFormSchema),
    defaultValues: values,
    mode: "onBlur",
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "headers",
  });
  const method = watch("method");
  const intervalMinutes = watch("intervalMinutes");
  const showBodyField = ["POST", "PUT", "PATCH"].includes(method);
  const showQuotaWarning = intervalMinutes > 0 && intervalMinutes < 5;

  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty || submitting) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [isDirty, submitting]);

  const cancel = () => {
    if (isDirty && !window.confirm(t("monitor.form.discardChanges"))) return;
    onCancel();
  };

  return (
    <div className="sm:px-6 lg:px-[8%]">
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" onClick={cancel}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="prompt-title">{title}</h1>
      </div>

      <div className="terminal-card my-4 p-4">
        <form
          noValidate
          onSubmit={handleSubmit(async (formValues) => {
            await onSubmit(monitorFormToMutation(formValues));
          })}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="monitor-name">
              {t("monitor.form.name")} *
            </label>
            <Input
              id="monitor-name"
              autoComplete="off"
              placeholder={t("monitor.form.namePlaceholder")}
              aria-invalid={Boolean(errors.name)}
              {...register("name")}
            />
            {errors.name && (
              <p className="mt-1 text-sm text-destructive" role="alert">
                {t("monitor.form.invalidName")}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="monitor-url">
              URL *
            </label>
            <Input
              id="monitor-url"
              inputMode="url"
              placeholder={t("monitor.form.urlPlaceholder")}
              aria-invalid={Boolean(errors.url)}
              {...register("url")}
            />
            {errors.url && (
              <p className="mt-1 text-sm text-destructive" role="alert">
                {t("monitor.form.invalidUrl")}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("monitor.form.method")} *
            </label>
            <Controller
              control={control}
              name="method"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label={t("monitor.form.method")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                className="mb-1 block text-sm font-medium"
                htmlFor="monitor-interval"
              >
                {t("monitor.form.interval")} *
              </label>
              <Input
                id="monitor-interval"
                type="number"
                min="1"
                max="1440"
                aria-invalid={Boolean(errors.intervalMinutes)}
                {...register("intervalMinutes", { valueAsNumber: true })}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("monitor.form.intervalMin")}
              </p>
              {showQuotaWarning && (
                <p className="mt-1 text-xs text-[var(--accent-yellow)]">
                  {t("monitor.form.intervalQuotaWarning")}
                </p>
              )}
            </div>
            <div>
              <label
                className="mb-1 block text-sm font-medium"
                htmlFor="monitor-timeout"
              >
                {t("monitor.form.timeout")} *
              </label>
              <Input
                id="monitor-timeout"
                type="number"
                min="0.1"
                max="300"
                step="0.1"
                aria-invalid={Boolean(errors.timeoutSeconds)}
                {...register("timeoutSeconds", { valueAsNumber: true })}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t("monitor.form.expectedStatus")} *
            </label>
            <Controller
              control={control}
              name="expectedStatus"
              render={({ field }) => (
                <StatusCodeSelect
                  value={field.value}
                  onChange={field.onChange}
                  required
                />
              )}
            />
          </div>

          <div>
            <div className="mb-1 text-sm font-medium">
              {t("monitor.form.headers")}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableCell>{t("monitor.form.headerName")}</TableCell>
                  <TableCell>{t("monitor.form.headerValue")}</TableCell>
                  <TableCell className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map((header, index) => (
                  <TableRow key={header.id}>
                    <TableCell>
                      <Input
                        aria-label={t("monitor.form.headerName")}
                        placeholder={t("monitor.form.headerNamePlaceholder")}
                        aria-invalid={Boolean(errors.headers?.[index]?.key)}
                        {...register(`headers.${index}.key`)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label={t("monitor.form.headerValue")}
                        placeholder={t("monitor.form.headerValuePlaceholder")}
                        {...register(`headers.${index}.value`)}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        aria-label={t("common.delete")}
                        disabled={fields.length === 1}
                        onClick={() => remove(index)}
                      >
                        <TrashIcon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {errors.headers && (
              <p className="mt-1 text-sm text-destructive" role="alert">
                {t("monitor.form.invalidHeaders")}
              </p>
            )}
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                disabled={fields.length >= 50}
                onClick={() => append({ key: "", value: "" })}
              >
                <PlusIcon />
                {t("monitor.form.addHeader")}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("monitor.form.headersHelp")}
            </p>
          </div>

          {showBodyField && (
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="monitor-body">
                {t("monitor.form.body")}
              </label>
              <Textarea
                id="monitor-body"
                placeholder={t("monitor.form.bodyPlaceholder")}
                aria-invalid={Boolean(errors.body)}
                {...register("body")}
              />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={cancel}>
              {t("monitor.form.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? submittingLabel : submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
