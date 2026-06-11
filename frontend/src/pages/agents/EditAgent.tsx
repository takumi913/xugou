import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Box, Flex, Heading, Text } from "@/components/ui/theme-shim";
import { Button, Card, Input } from "@/components/ui";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { getAgent, updateAgent } from "../../api/agents";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Agent } from "../../types/agents";

const EditAgent = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [formData, setFormData] = useState<{
    name: string;
    status: Agent["status"];
  }>({
    name: "",
    status: "inactive",
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
    setLoading(true);

    // 准备提交数据 - 只包含名称
    const payload = {
      name: formData.name,
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
            <Heading size="6">
              {t("agent.form.editingClient", { name: formData.name })}
            </Heading>
          </Flex>
        </Flex>
        <Card className="mt-4 pr-4">
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
        </Card>
      </div>
    </Box>
  );
};

export default EditAgent;
