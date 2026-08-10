import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ReloadIcon } from "@radix-ui/react-icons";
import {
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
import {
  getCredentialCoverage,
  getSecurityAuditEvents,
  type SecurityAuditEvent,
  type SecurityAuditOutcome,
} from "@/api/operations";

type OutcomeFilter = SecurityAuditOutcome | "all";

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date);
}

function auditBadgeColor(
  outcome: SecurityAuditOutcome
): "green" | "red" | "gray" {
  if (outcome === "success") return "green";
  if (outcome === "failure") return "red";
  return "gray";
}

export default function SecurityOperationsPanel() {
  const { t, i18n } = useTranslation();
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const query = useQuery({
    queryKey: ["operations", "security", outcome, cursor ?? null],
    queryFn: async () => {
      const [coverage, audit] = await Promise.all([
        getCredentialCoverage(),
        getSecurityAuditEvents({
          cursor,
          outcome: outcome === "all" ? undefined : outcome,
          limit: 10,
        }),
      ]);
      return { coverage, audit };
    },
  });

  useEffect(() => {
    if (query.error) toast.error(t("operations.security.fetchError"));
  }, [query.error, t]);

  const changeOutcome = (value: OutcomeFilter) => {
    setOutcome(value);
    setCursor(undefined);
    setCursorHistory([]);
  };
  const nextCursor = query.data?.audit.has_more
    ? query.data.audit.next_cursor
    : null;
  const nextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
  };
  const previousPage = () => {
    setCursor(cursorHistory.at(-1));
    setCursorHistory((history) => history.slice(0, -1));
  };

  const coverage = query.data?.coverage;
  const events: SecurityAuditEvent[] = query.data?.audit.data ?? [];

  return (
    <div className="mb-4 grid gap-3 xl:grid-cols-[minmax(18rem,0.7fr)_minmax(0,1.3fr)]">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">{t("operations.coverage.title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("operations.coverage.description")}
            </div>
          </div>
          <Badge color={coverage?.ready_for_credential_contract ? "green" : "red"}>
            {coverage?.ready_for_credential_contract
              ? t("operations.readiness.ready")
              : t("operations.readiness.blocked")}
          </Badge>
        </div>
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span>{t("operations.coverage.agentCredentials")}</span>
            <span className="font-mono">
              {coverage
                ? `${coverage.agent_credentials.covered}/${coverage.agent_credentials.total}`
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>{t("operations.coverage.notificationEndpoints")}</span>
            <span className="font-mono">
              {coverage
                ? `${coverage.notification_secrets.endpointCovered}/${coverage.notification_secrets.total}`
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>{t("operations.coverage.currentKey")}</span>
            <span className="font-mono">
              {coverage
                ? `${coverage.notification_secrets.currentKeyRows}/${coverage.notification_secrets.encryptedSecretRows}`
                : "—"}
            </span>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div>
            <div className="font-medium">{t("operations.audit.title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("operations.audit.description")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={outcome}
              onValueChange={(value) => changeOutcome(value as OutcomeFilter)}
            >
              <SelectTrigger aria-label={t("operations.audit.outcomeFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("operations.audit.outcome.all")}</SelectItem>
                <SelectItem value="success">
                  {t("operations.audit.outcome.success")}
                </SelectItem>
                <SelectItem value="failure">
                  {t("operations.audit.outcome.failure")}
                </SelectItem>
                <SelectItem value="denied">
                  {t("operations.audit.outcome.denied")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <ReloadIcon className={query.isFetching ? "animate-spin" : ""} />
              {t("common.refresh")}
            </Button>
          </div>
        </div>
        {events.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center p-4 text-sm text-muted-foreground">
            {query.isPending ? t("common.loading") : t("operations.audit.empty")}
          </div>
        ) : (
          <Table aria-busy={query.isFetching}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("operations.audit.event")}</TableHead>
                <TableHead>{t("operations.audit.actor")}</TableHead>
                <TableHead>{t("operations.audit.subject")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("operations.audit.createdAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-mono text-xs">
                    {event.event_type}
                  </TableCell>
                  <TableCell className="text-xs">
                    {event.actor_type}
                    {event.actor_id ? `:${event.actor_id}` : ""}
                  </TableCell>
                  <TableCell className="text-xs">
                    {event.subject_type
                      ? `${event.subject_type}${event.subject_id ? `:${event.subject_id}` : ""}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge color={auditBadgeColor(event.outcome)}>
                      {t(`operations.audit.outcome.${event.outcome}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDate(event.created_at, i18n.language)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {t("operations.pageCount", { count: events.length })}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching || cursorHistory.length === 0}
              onClick={previousPage}
            >
              {t("operations.previous")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching || !nextCursor}
              onClick={nextPage}
            >
              {t("operations.next")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
