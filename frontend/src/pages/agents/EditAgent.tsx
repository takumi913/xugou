import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Box, Flex, Heading, Text } from "@/components/ui/theme-shim";
import {
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@/components/ui";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { getAgent, updateAgent } from "../../api/agents";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  Agent,
  BillingCycle,
  TrafficCalcType,
} from "../../types/agents";
import { BILLING_CYCLES, BILLING_CYCLE_KEYS } from "../../utils/billing";

// 流量计费方式选项与 i18n key（与后端 traffic_calc_type 枚举一致）
const TRAFFIC_CALC_TYPES: TrafficCalcType[] = ["sum", "rx", "tx"];
const TRAFFIC_CALC_TYPE_KEYS: Record<TrafficCalcType, string> = {
  sum: "agent.traffic.calc.sum",
  rx: "agent.traffic.calc.rx",
  tx: "agent.traffic.calc.tx",
};

const EditAgent = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [formData, setFormData] = useState<{
    name: string;
    status: Agent["status"];
    collect_interval: string;
    report_interval: string;
    price: string;
    currency: string;
    billing_cycle: BillingCycle | "none";
    expire_date: string;
    auto_renewal: boolean;
    is_hidden: boolean;
    traffic_limit_gb: string;
    traffic_reset_day: string;
    traffic_calc_type: TrafficCalcType;
    auto_update: boolean;
    group_name: string;
    tags: string;
  }>({
    name: "",
    status: "inactive",
    collect_interval: "60",
    report_interval: "300",
    price: "",
    currency: "USD",
    billing_cycle: "none",
    expire_date: "",
    auto_renewal: false,
    is_hidden: false,
    traffic_limit_gb: "",
    traffic_reset_day: "1",
    traffic_calc_type: "sum",
    auto_update: false,
    group_name: "",
    tags: "",
  });
  const { t } = useTranslation();

  const fetchAgentData = useCallback(async () => {
    setLoading(true);

    const response = await getAgent(Number(id));

    if (response.success && response.agent) {
      const agent = response.agent;

      setFormData({
        name: agent.name,
        status: agent.status ?? "inactive",
        collect_interval: String(agent.collect_interval ?? 60),
        report_interval: String(agent.report_interval ?? 300),
        price:
          typeof agent.price === "number" && agent.price >= 0
            ? String(agent.price)
            : "",
        currency: agent.currency || "USD",
        billing_cycle: agent.billing_cycle ?? "none",
        expire_date: agent.expire_date ?? "",
        auto_renewal: agent.auto_renewal === 1,
        is_hidden: agent.is_hidden === 1,
        traffic_limit_gb:
          typeof agent.traffic_limit_gb === "number" &&
          agent.traffic_limit_gb > 0
            ? String(agent.traffic_limit_gb)
            : "",
        traffic_reset_day: String(agent.traffic_reset_day ?? 1),
        traffic_calc_type: TRAFFIC_CALC_TYPES.includes(
          agent.traffic_calc_type as TrafficCalcType
        )
          ? (agent.traffic_calc_type as TrafficCalcType)
          : "sum",
        auto_update: agent.auto_update === 1,
        group_name: agent.group_name ?? "",
        tags: agent.tags ?? "",
      });
    } else {
      setNotFound(true);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (id) {
      fetchAgentData();
    }
  }, [fetchAgentData, id]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const collectInterval = Number(formData.collect_interval);
    const reportInterval = Number(formData.report_interval);
    if (reportInterval < collectInterval) {
      toast.error(t("agent.form.intervalError"));
      return;
    }

    const trimmedPrice = formData.price.trim();
    const price = trimmedPrice === "" ? null : Number(trimmedPrice);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      toast.error(t("agent.form.priceError"));
      return;
    }

    // 流量：上限可空（=不限），有值必须 > 0；重置日 1-28 整数
    const trimmedTrafficLimit = formData.traffic_limit_gb.trim();
    const trafficLimitGb =
      trimmedTrafficLimit === "" ? null : Number(trimmedTrafficLimit);
    if (
      trafficLimitGb !== null &&
      (!Number.isFinite(trafficLimitGb) || trafficLimitGb <= 0)
    ) {
      toast.error(t("agent.form.trafficLimitError"));
      return;
    }
    const trafficResetDay = Number(formData.traffic_reset_day);
    if (
      !Number.isInteger(trafficResetDay) ||
      trafficResetDay < 1 ||
      trafficResetDay > 28
    ) {
      toast.error(t("agent.form.trafficResetDayError"));
      return;
    }

    setLoading(true);

    // 准备提交数据 - 名称 + 采集/上报间隔 + 账单信息 + 隐藏开关 + 流量配置
    const payload = {
      name: formData.name,
      collect_interval: collectInterval,
      report_interval: reportInterval,
      price,
      currency: formData.currency.trim() || "USD",
      billing_cycle:
        formData.billing_cycle === "none" ? null : formData.billing_cycle,
      expire_date: formData.expire_date || null,
      auto_renewal: formData.auto_renewal ? 1 : 0,
      is_hidden: formData.is_hidden ? 1 : 0,
      traffic_limit_gb: trafficLimitGb,
      traffic_reset_day: trafficResetDay,
      traffic_calc_type: formData.traffic_calc_type,
      auto_update: formData.auto_update ? 1 : 0,
      group_name: formData.group_name.trim() || null,
      tags: formData.tags.trim() || null,
    };

    // 调用API更新客户端
    const response = await updateAgent(Number(id), payload);

    if (response.success) {
      toast.success(t("agent.form.updateSuccess"));

      // 短暂延迟后导航，让用户有时间看到提示
      setTimeout(() => {
        navigate("/agents");
      }, 1500);
    } else {
      toast.error(t("agent.form.updateError", "Failed to update agent."));
    }
    setLoading(false);
  };

  if (notFound) {
    return (
      <Box>
        <Flex justify="center" align="center">
          <Card>
            <Flex direction="column" align="center" gap="4" p="4">
              <Heading size="6">{t("agents.notFound")}</Heading>
              <Text>{t("agents.notFoundId", { id })}</Text>
              <Button onClick={() => navigate("/agents")}>
                {t("common.backToList")}
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Box>
    );
  }

  return (
    <Box>
      <div className="sm:px-6 lg:px-[8%]">
        <Flex justify="between" align="center">
          <Flex align="center" gap="2">
            <Button
              variant="secondary"
              onClick={() => navigate(`/agents/${id}`)}
            >
              <ArrowLeftIcon />
            </Button>
            <h1 className="prompt-title">
              {t("agent.form.editingClient", { name: formData.name })}
            </h1>
          </Flex>
        </Flex>
        <div className="terminal-card mt-4 py-4 pr-4">
          <form onSubmit={handleSubmit}>
            <Flex direction="column" gap="2" className="ml-4">
              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.name")}{" "}
                  <Text size="2" color="red">
                    *
                  </Text>
                </Text>
                <Input
                  className="h-10"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  placeholder={t("agent.form.namePlaceholder")}
                  required
                />
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.nameHelp")}
                </Text>
              </Box>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.collectInterval")}
                </Text>
                <Input
                  className="h-10"
                  type="number"
                  name="collect_interval"
                  value={formData.collect_interval}
                  onChange={handleChange}
                  min={1}
                  max={3600}
                  required
                />
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.collectIntervalHelp")}
                </Text>
              </Box>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.reportInterval")}
                </Text>
                <Input
                  className="h-10"
                  type="number"
                  name="report_interval"
                  value={formData.report_interval}
                  onChange={handleChange}
                  min={10}
                  max={3600}
                  required
                />
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.reportIntervalHelp")}
                </Text>
              </Box>

              {/* 自动升级开关：服务端在配置下发响应中触发探针自升级 */}
              <Box mb="4">
                <Flex align="center" gap="2">
                  <Switch
                    checked={formData.auto_update}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({
                        ...prev,
                        auto_update: checked === true,
                      }))
                    }
                  />
                  <Text as="label" size="2" weight="bold">
                    {t("agent.form.autoUpdate")}
                  </Text>
                </Flex>
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.autoUpdateHelp")}
                </Text>
              </Box>

              {/* 分组与标签区块 */}
              <h2 className="group-title">{t("agent.form.groupSection")}</h2>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.groupName")}
                </Text>
                <Input
                  className="h-10"
                  name="group_name"
                  value={formData.group_name}
                  onChange={handleChange}
                  maxLength={64}
                  placeholder={t("agent.form.groupNamePlaceholder")}
                />
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.groupNameHelp")}
                </Text>
              </Box>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.tags")}
                </Text>
                <Input
                  className="h-10"
                  name="tags"
                  value={formData.tags}
                  onChange={handleChange}
                  maxLength={512}
                  placeholder="web, prod, hk"
                />
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.tagsHelp")}
                </Text>
              </Box>

              {/* 账单与到期区块 */}
              <h2 className="group-title">{t("agent.form.billingSection")}</h2>

              <Flex gap="4" direction={{ initial: "column", sm: "row" }}>
                <Box mb="4" className="flex-1">
                  <Text as="label" size="2" mb="1" weight="bold">
                    {t("agent.form.price")}
                  </Text>
                  <Input
                    className="h-10"
                    type="number"
                    name="price"
                    value={formData.price}
                    onChange={handleChange}
                    min={0}
                    step="0.01"
                    placeholder="9.99"
                  />
                </Box>
                <Box mb="4" className="w-32">
                  <Text as="label" size="2" mb="1" weight="bold">
                    {t("agent.form.currency")}
                  </Text>
                  <Input
                    className="h-10"
                    name="currency"
                    value={formData.currency}
                    onChange={handleChange}
                    maxLength={16}
                    placeholder="USD"
                  />
                </Box>
              </Flex>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.billingCycle")}
                </Text>
                <Select
                  value={formData.billing_cycle}
                  onValueChange={(value) =>
                    setFormData((prev) => ({
                      ...prev,
                      billing_cycle: value as typeof prev.billing_cycle,
                    }))
                  }
                >
                  <SelectTrigger className="h-10">
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
              </Box>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.expireDate")}
                </Text>
                <Input
                  className="h-10"
                  type="date"
                  name="expire_date"
                  value={formData.expire_date}
                  onChange={handleChange}
                />
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.expireDateHelp")}
                </Text>
              </Box>

              <Box mb="4">
                <Flex align="center" gap="2">
                  <Switch
                    checked={formData.auto_renewal}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({
                        ...prev,
                        auto_renewal: checked === true,
                      }))
                    }
                  />
                  <Text as="label" size="2" weight="bold">
                    {t("agent.form.autoRenewal")}
                  </Text>
                </Flex>
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.autoRenewalHelp")}
                </Text>
              </Box>

              {/* 流量管理区块：月流量上限 / 重置日 / 计费方式 */}
              <h2 className="group-title">{t("agent.form.trafficSection")}</h2>

              <Flex gap="4" direction={{ initial: "column", sm: "row" }}>
                <Box mb="4" className="flex-1">
                  <Text as="label" size="2" mb="1" weight="bold">
                    {t("agent.form.trafficLimit")}
                  </Text>
                  <Input
                    className="h-10"
                    type="number"
                    name="traffic_limit_gb"
                    value={formData.traffic_limit_gb}
                    onChange={handleChange}
                    min={0}
                    step="0.1"
                    placeholder="1024"
                  />
                  <Text size="1" color="gray" mt="1">
                    {t("agent.form.trafficLimitHelp")}
                  </Text>
                </Box>
                <Box mb="4" className="w-32">
                  <Text as="label" size="2" mb="1" weight="bold">
                    {t("agent.form.trafficResetDay")}
                  </Text>
                  <Input
                    className="h-10"
                    type="number"
                    name="traffic_reset_day"
                    value={formData.traffic_reset_day}
                    onChange={handleChange}
                    min={1}
                    max={28}
                    step="1"
                  />
                  <Text size="1" color="gray" mt="1">
                    {t("agent.form.trafficResetDayHelp")}
                  </Text>
                </Box>
              </Flex>

              <Box mb="4">
                <Text as="label" size="2" mb="1" weight="bold">
                  {t("agent.form.trafficCalcType")}
                </Text>
                <Select
                  value={formData.traffic_calc_type}
                  onValueChange={(value) =>
                    setFormData((prev) => ({
                      ...prev,
                      traffic_calc_type: value as TrafficCalcType,
                    }))
                  }
                >
                  <SelectTrigger className="h-10">
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
              </Box>

              {/* 公开状态页隐藏开关 */}
              <h2 className="group-title">{t("agent.form.visibilitySection")}</h2>

              <Box mb="4">
                <Flex align="center" gap="2">
                  <Switch
                    checked={formData.is_hidden}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({
                        ...prev,
                        is_hidden: checked === true,
                      }))
                    }
                  />
                  <Text as="label" size="2" weight="bold">
                    {t("agent.form.hideFromStatusPage")}
                  </Text>
                </Flex>
                <Text size="1" color="gray" mt="1">
                  {t("agent.form.hideFromStatusPageHelp")}
                </Text>
              </Box>

              <Flex justify="end" mt="4" gap="2">
                <Button
                  variant="secondary"
                  onClick={() => navigate(`/agents/${id}`)}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading
                    ? t("common.savingChanges")
                    : t("common.saveChanges")}
                </Button>
              </Flex>
            </Flex>
          </form>
        </div>
      </div>
    </Box>
  );
};

export default EditAgent;
