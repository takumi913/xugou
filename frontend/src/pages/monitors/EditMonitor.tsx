import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Box,
  Flex,
  Heading,
  Text,
  IconButton,
  Container,
} from "@/components/ui/theme-shim";

import {
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  Textarea,
  Input,
} from "@/components/ui";
import {
  ArrowLeftIcon,
  UpdateIcon,
  PlusIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { getMonitor, updateMonitor } from "../../api/monitors";
import StatusCodeSelect from "../../components/StatusCodeSelect";
import { useTranslation } from "react-i18next";

const EditMonitor = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    name: "",
    url: "",
    method: "GET",
    interval: 60,
    timeout: 30,
    expectedStatus: 200,
    body: "",
  });

  // 请求头部分使用键值对数组
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([
    { key: "", value: "" },
  ]);

  useEffect(() => {
    // 获取监控数据
    const fetchMonitor = async () => {
      if (!id) return;

      try {
        setLoadingData(true);
        const response = await getMonitor(parseInt(id));

        if (response.success && response.monitor) {
          const monitor = response.monitor;
          setFormData({
            name: monitor.name,
            url: monitor.url,
            method: monitor.method,
            interval: Math.floor(monitor.interval / 60), // 从秒转换为分钟
            timeout: monitor.timeout,
            expectedStatus: monitor.expected_status || 200,
            body: monitor.body || "",
          });

          // 处理请求头
          if (monitor.headers) {
            try {
              // 确保 headers 是对象
              const headersObj =
                typeof monitor.headers === "string"
                  ? JSON.parse(monitor.headers)
                  : monitor.headers;

              const headerPairs = Object.entries(headersObj).map(
                ([key, value]) => ({
                  key,
                  value: value as string,
                })
              );

              // 如果没有请求头，添加一个空行，否则添加一个空行用于新增
              if (headerPairs.length === 0) {
                headerPairs.push({ key: "", value: "" });
              } else {
                headerPairs.push({ key: "", value: "" });
              }

              setHeaders(headerPairs);
            } catch (error) {
              console.error(t("common.error.fetch"), error);
              setHeaders([{ key: "", value: "" }]);
            }
          }
        } else {
          setError(response.message || t("common.error.fetch"));
        }
      } catch (err) {
        console.error(t("common.error.fetch"), err);
        setError(t("common.error.fetch"));
      } finally {
        setLoadingData(false);
      }
    };

    fetchMonitor();
  }, [id, t]);

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]:
        name === "interval" || name === "timeout" || name === "expectedStatus"
          ? parseInt(value) || 0
          : value,
    }));
  };

  // 处理状态码变更
  const handleStatusCodeChange = (value: number) => {
    setFormData((prev) => ({ ...prev, expectedStatus: value }));
  };

  // 处理请求头键值对更改
  const handleHeaderChange = (
    index: number,
    field: "key" | "value",
    value: string
  ) => {
    const newHeaders = [...headers];
    newHeaders[index][field] = value;
    setHeaders(newHeaders);
  };

  // 删除请求头行
  const removeHeader = (index: number) => {
    if (headers.length > 1) {
      const newHeaders = [...headers];
      newHeaders.splice(index, 1);
      setHeaders(newHeaders);
    }
  };

  // 将键值对转换为对象
  const headersToObject = () => {
    const result: Record<string, string> = {};

    headers.forEach(({ key, value }) => {
      // 只处理有效的键值对
      if (key.trim()) {
        result[key.trim()] = value;
      }
    });

    return result;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;

    setLoading(true);

    try {
      // 获取处理后的请求头数据
      const headersData = headersToObject();

      // 调用实际 API
      const response = await updateMonitor(parseInt(id), {
        name: formData.name,
        url: formData.url,
        method: formData.method,
        interval: formData.interval * 60, // 转换为秒
        timeout: formData.timeout,
        expected_status: formData.expectedStatus, // 使用统一字段名
        headers: headersData,
        body: formData.body,
      });

      if (response.success) {
        navigate(`/monitors/${id}`);
      } else {
        alert(
          `${t("monitor.form.updateFailed")}: ${
            response.message || t("monitor.form.unknownError")
          }`
        );
      }
    } catch (error) {
      console.error(t("monitor.form.updateFailed"), error);
      alert(t("monitor.form.updateFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 判断是否需要显示请求体输入框
  const showBodyField = ["POST", "PUT", "PATCH"].includes(formData.method);
  const showQuotaWarning = formData.interval > 0 && formData.interval < 5;

  if (loadingData) {
    return (
      <Box>
        <Flex justify="center" align="center">
          <Text>{t("common.loading")}</Text>
        </Flex>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Flex justify="center" align="center">
          <Card>
            <Flex direction="column" align="center" gap="4" p="4">
              <Heading size="6">{t("monitor.notExist")}</Heading>
              <Text>{error}</Text>
              <Button onClick={() => navigate("/monitors")}>
                {t("monitor.returnToList")}
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Box>
    );
  }

  return (
    <Container className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="center" className="detail-header">
        <Flex align="center" gap="2">
          <Button
            variant="secondary"
            onClick={() => navigate(`/monitors/${id}`)}
          >
            <ArrowLeftIcon />
          </Button>
          <Heading size="6">
            {t("monitor.form.title.edit")}: {formData.name}
          </Heading>
        </Flex>
      </Flex>
      <Card className="my-4 pr-4">
        <form onSubmit={handleSubmit}>
          <Box pt="2">
            <Flex direction="column" gap="2" className="ml-4">
              <Box>
                <Text as="label" size="2">
                  {t("monitor.form.name")} *
                </Text>
                <Input
                  className="h-10"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  placeholder={t("monitor.form.namePlaceholder")}
                  required
                />
              </Box>

              <Box>
                <Text as="label" size="2">
                  URL *
                </Text>
                <Input
                  className="h-10"
                  name="url"
                  value={formData.url}
                  onChange={handleChange}
                  placeholder={t("monitor.form.urlPlaceholder")}
                  required
                />
              </Box>

              <Box>
                <Text as="label" size="2">
                  {t("monitor.form.method")} *
                </Text>
                <Select
                  name="method"
                  value={formData.method}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, method: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GET">GET</SelectItem>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                    <SelectItem value="DELETE">DELETE</SelectItem>
                    <SelectItem value="HEAD">HEAD</SelectItem>
                  </SelectContent>
                </Select>
              </Box>

              <Flex gap="4">
                <Box>
                  <Text as="label" size="2">
                    {t("monitor.form.interval")} *
                  </Text>
                  <Input
                    className="h-10"
                    name="interval"
                    type="number"
                    value={formData.interval.toString()}
                    onChange={handleChange}
                    min="1"
                    required
                  />
                  <Text size="1" color="gray">
                    {t("monitor.form.intervalMin")}
                  </Text>
                  {showQuotaWarning && (
                    <Text size="1" className="block mt-1 text-amber-600">
                      {t("monitor.form.intervalQuotaWarning")}
                    </Text>
                  )}
                </Box>

                <Box>
                  <Text as="label" size="2">
                    {t("monitor.form.timeout")} *
                  </Text>
                  <Input
                    className="h-10"
                    name="timeout"
                    type="number"
                    value={formData.timeout.toString()}
                    onChange={handleChange}
                    min="1"
                    required
                  />
                </Box>
              </Flex>

              <Box>
                <Text as="label" size="2">
                  {t("monitor.form.expectedStatus")} *
                </Text>
                <StatusCodeSelect
                  value={formData.expectedStatus}
                  onChange={handleStatusCodeChange}
                  required
                />
              </Box>

              <Box>
                <Text as="label" size="2">
                  {t("monitor.form.headers")}
                </Text>
                <Box>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableCell>{t("monitor.form.headerName")}</TableCell>
                        <TableCell>{t("monitor.form.headerValue")}</TableCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {headers.map((header, index) => (
                        <TableRow key={index}>
                          <TableCell>
                            <Input
                              placeholder={t(
                                "monitor.form.headerNamePlaceholder"
                              )}
                              value={header.key}
                              onChange={(e) =>
                                handleHeaderChange(index, "key", e.target.value)
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              placeholder={t(
                                "monitor.form.headerValuePlaceholder"
                              )}
                              value={header.value}
                              onChange={(e) =>
                                handleHeaderChange(
                                  index,
                                  "value",
                                  e.target.value
                                )
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <IconButton
                              variant="soft"
                              color="red"
                              size="1"
                              onClick={(e) => {
                                e.preventDefault();
                                removeHeader(index);
                              }}
                            >
                              <TrashIcon />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Flex justify="end" mt="2">
                    <Button
                      variant="secondary"
                      onClick={(e) => {
                        e.preventDefault();
                        setHeaders([...headers, { key: "", value: "" }]);
                      }}
                      type="button"
                    >
                      <PlusIcon />
                      {t("monitor.form.addHeader")}
                    </Button>
                  </Flex>
                </Box>
                <Text size="1" color="gray">
                  {t("monitor.form.headersHelp")}
                </Text>
              </Box>

              {showBodyField && (
                <Box>
                  <Text as="label" size="2">
                    {t("monitor.form.body")}
                  </Text>
                  <Textarea
                    name="body"
                    value={formData.body}
                    onChange={handleChange}
                    placeholder={t("monitor.form.bodyPlaceholder")}
                  />
                </Box>
              )}
            </Flex>
          </Box>

          <Flex justify="end" mt="4" gap="2">
            <Button
              variant="secondary"
              onClick={() => navigate(`/monitors/${id}`)}
            >
              {t("monitor.form.cancel")}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t("common.savingChanges") : t("common.saveChanges")}
              {!loading && <UpdateIcon />}
            </Button>
          </Flex>
        </form>
      </Card>
    </Container>
  );
};

export default EditMonitor;
