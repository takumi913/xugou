import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ExclamationTriangleIcon, ReloadIcon } from "@radix-ui/react-icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import PageLoading from "@/components/PageLoading";
import {
  getCompatibilityHits,
  getQueueFailures,
  getQueueHealth,
  getReleaseReadiness,
  replayQueueFailure,
  terminateQueueFailure,
  type ReleaseReadiness,
  type QueueFailure,
  type QueueFailureStatus,
} from "@/api/operations";
import { OpenApiRequestError } from "@/api/generated/v2-client";
import SecurityOperationsPanel from "./SecurityOperationsPanel";

type StatusFilter = QueueFailureStatus | "all";

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OpenApiRequestError) {
    const body = error.problem;
    if (body && typeof body === "object" && "title" in body) {
      const title = body.title;
      if (typeof title === "string" && title.length > 0) return title;
    }
  }
  return fallback;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date);
}

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

function statusColor(status: QueueFailureStatus): "red" | "green" | "gray" {
  if (status === "open") return "red";
  if (status === "replayed") return "green";
  return "gray";
}

export default function QueueFailures() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const queueQuery = useQuery({
    queryKey: ["operations", "queue", status, cursor ?? null],
    queryFn: async () => {
      const [page, health, readiness, compatibilityHits] = await Promise.all([
        getQueueFailures({
          cursor,
          status: status === "all" ? undefined : status,
          limit: 50,
        }),
        getQueueHealth(),
        getReleaseReadiness(),
        getCompatibilityHits(30),
      ]);
      return { page, health, readiness, compatibilityHits };
    },
  });
  const rows: QueueFailure[] = queueQuery.data?.page.data ?? [];
  const nextCursor = queueQuery.data?.page.has_more
    ? queueQuery.data.page.next_cursor
    : null;
  const health = queueQuery.data?.health ?? null;
  const readiness = queueQuery.data?.readiness ?? null;
  const compatibilityHits = queueQuery.data?.compatibilityHits ?? [];
  const loading = queueQuery.isFetching;

  useEffect(() => {
    if (queueQuery.error) {
      toast.error(getErrorMessage(queueQuery.error, t("operations.fetchError")));
    }
  }, [queueQuery.error, t]);

  const replayMutation = useMutation({
    mutationFn: replayQueueFailure,
    onSuccess: async () => {
      toast.success(t("operations.replaySuccess"));
      await queryClient.invalidateQueries({ queryKey: ["operations", "queue"] });
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, t("operations.replayError"))),
  });
  const terminateMutation = useMutation({
    mutationFn: terminateQueueFailure,
    onSuccess: async () => {
      toast.success(t("operations.terminateSuccess"));
      await queryClient.invalidateQueries({ queryKey: ["operations", "queue"] });
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, t("operations.terminateError"))),
  });
  const actionId = replayMutation.isPending
    ? replayMutation.variables
    : terminateMutation.isPending
      ? terminateMutation.variables
      : null;

  const changeStatus = (value: StatusFilter) => {
    setStatus(value);
    setCursor(undefined);
    setCursorHistory([]);
  };

  const nextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
  };

  const previousPage = () => {
    const previous = cursorHistory.at(-1);
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previous);
  };

  const sum = (values: Record<string, number> | undefined, keys: string[]) =>
    keys.reduce((total, key) => total + (values?.[key] ?? 0), 0);

  return (
    <div className="page-container">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="prompt-title flex items-center gap-2">
            <ExclamationTriangleIcon />
            {t("operations.title")}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("operations.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(value) => changeStatus(value as StatusFilter)}>
            <SelectTrigger aria-label={t("operations.statusFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("operations.status.all")}</SelectItem>
              <SelectItem value="open">{t("operations.status.open")}</SelectItem>
              <SelectItem value="replayed">{t("operations.status.replayed")}</SelectItem>
              <SelectItem value="terminated">{t("operations.status.terminated")}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void queueQuery.refetch()} disabled={loading}>
            <ReloadIcon className={loading ? "animate-spin" : ""} />
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t("operations.health.jobs")}</div>
          <div className="mt-1 text-2xl font-semibold">
            {health ? sum(health.jobs, ["pending", "retry", "processing"]) : "—"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("operations.health.lag", { seconds: health?.job_lag_seconds ?? 0 })}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t("operations.health.outbox")}</div>
          <div className="mt-1 text-2xl font-semibold">
            {health ? sum(health.outbox, ["pending", "published"]) : "—"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("operations.health.lag", { seconds: health?.outbox_lag_seconds ?? 0 })}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t("operations.health.notifications")}</div>
          <div className="mt-1 text-2xl font-semibold">
            {health ? sum(health.notifications, ["pending", "retry", "sending", "failed"]) : "—"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("operations.health.pending")}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t("operations.health.failures")}</div>
          <div className="mt-1 text-2xl font-semibold">{health?.open_failures ?? "—"}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("operations.health.open")}
          </div>
        </Card>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">{t("operations.readiness.title")}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("operations.readiness.version", {
                  version: readiness?.release_version ?? "—",
                })}
              </div>
            </div>
            <Badge color={readiness?.release_ready ? "green" : "red"}>
              {readiness?.release_ready
                ? t("operations.readiness.ready")
                : t("operations.readiness.blocked")}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(readiness?.checks ?? []).map(
              (item: ReleaseReadiness["checks"][number]) => (
              <div
                key={item.key}
                className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
              >
                <span className="truncate" title={item.key}>{item.key}</span>
                <span className={item.ready ? "text-green-600" : "text-destructive"}>
                  {item.actual ?? "—"} / {item.threshold}
                </span>
              </div>
              )
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="font-medium">{t("operations.compatibility.title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("operations.compatibility.description")}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">
                {t("operations.compatibility.management")}
              </div>
              <div className="mt-1 text-xl font-semibold">
                {readiness?.compatibility_windows.management_hits ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("operations.compatibility.days", {
                  days: readiness?.compatibility_windows.management_quiet_days ?? 0,
                })}
              </div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">
                {t("operations.compatibility.agent")}
              </div>
              <div className="mt-1 text-xl font-semibold">
                {readiness?.compatibility_windows.agent_hits ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("operations.compatibility.days", {
                  days: readiness?.compatibility_windows.agent_quiet_days ?? 0,
                })}
              </div>
            </div>
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            {t("operations.compatibility.rows", { count: compatibilityHits.length })}
          </div>
        </Card>
      </div>

      <SecurityOperationsPanel />

      <Card className="overflow-hidden p-0">
        {loading && rows.length === 0 ? (
          <div className="min-h-56">
            <PageLoading />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-2 p-6 text-center">
            <ExclamationTriangleIcon className="size-7 text-muted-foreground" />
            <p className="font-medium">{t("operations.empty")}</p>
            <p className="text-xs text-muted-foreground">{t("operations.emptyDescription")}</p>
          </div>
        ) : (
          <Table aria-busy={loading}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("operations.columns.failure")}</TableHead>
                <TableHead>{t("operations.columns.source")}</TableHead>
                <TableHead>{t("operations.columns.attempts")}</TableHead>
                <TableHead>{t("operations.columns.error")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("operations.columns.createdAt")}</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.failure_id}>
                  <TableCell>
                    <div className="font-mono text-xs" title={row.failure_id}>
                      {shortId(row.failure_id)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{row.queue_name}</div>
                  </TableCell>
                  <TableCell>
                    <div>{row.source_kind ?? t("common.unknown")}</div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground" title={row.source_id ?? undefined}>
                      {shortId(row.source_id)}
                    </div>
                  </TableCell>
                  <TableCell>{row.delivery_attempts}</TableCell>
                  <TableCell className="max-w-72 whitespace-normal">
                    <span className="line-clamp-3 text-xs" title={row.last_error ?? undefined}>
                      {row.last_error ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge color={statusColor(row.status)}>
                      {t(`operations.status.${row.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDate(row.created_at, i18n.language)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={row.status !== "open" || actionId !== null}
                        onClick={() => replayMutation.mutate(row.failure_id)}
                      >
                        {actionId === row.failure_id ? t("operations.processing") : t("operations.replay")}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={row.status !== "open" || actionId !== null}
                          >
                            {t("operations.terminate")}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("operations.terminateTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("operations.terminateDescription", { id: row.failure_id })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-white hover:bg-destructive/90"
                              onClick={() => terminateMutation.mutate(row.failure_id)}
                            >
                              {t("operations.confirmTerminate")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {t("operations.pageCount", { count: rows.length })}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading || cursorHistory.length === 0}
            onClick={previousPage}
          >
            {t("operations.previous")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || !nextCursor}
            onClick={nextPage}
          >
            {t("operations.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
