import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Flex, Heading, Text, IconButton } from "@/components/ui/theme-shim";
import {
  Button,
  Card,
  Textarea,
  Select,
  SelectContent,
  SelectTrigger,
  SelectItem,
  SelectValue,
  Table,
  TableCell,
  TableRow,
  TableBody,
  TableHeader,
  Input,
} from "@/components/ui";
import { ArrowLeftIcon, PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { createMonitor } from "../../api/monitors";
import StatusCodeSelect from "../../components/StatusCodeSelect";
import { useTranslation } from "react-i18next";

const CreateMonitor = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    url: "",
    method: "GET",
    interval: 5,
    timeout: 30,
    expectedStatus: 200,
    body: "",
  });
  const { t } = useTranslation();

  // 请求头部分使用键值对数组
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([
    { key: "", value: "" },
  ]);

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
      const trimmedKey = key.trim();
      // 只处理有效的键值对
      if (trimmedKey && !trimmedKey.includes("\\")) {
        result[trimmedKey] = value;
      }
    });

    return result;
  };

  // 处理状态码变更
  const handleStatusCodeChange = (value: number) => {
    setFormData((prev) => ({ ...prev, expectedStatus: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // 获取处理后的请求头数据（直接用对象）
      const headersData = headersToObject();

      // 调用实际API，将分钟转换为秒
      const response = await createMonitor({
        name: formData.name,
        url: formData.url,
        method: formData.method,
        interval: formData.interval * 60, // 转换为秒
        timeout: formData.timeout,
        expected_status: formData.expectedStatus,
        headers: headersData, // 直接使用对象
        body: formData.body,
      });

      if (response.success) {
        navigate("/monitors");
      } else {
        alert(
          `${t("monitor.form.createFailed")}: ${
            response.message || t("monitor.form.unknownError")
          }`
        );
      }
    } catch (error) {
      console.error(t("monitor.form.createFailed"), error);
      alert(t("monitor.form.createFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 判断是否需要显示请求体输入框
  const showBodyField = ["POST", "PUT", "PATCH"].includes(formData.method);
  const showQuotaWarning = formData.interval > 0 && formData.interval < 5;

  return (
    <Box className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="center">
        <Flex align="center" gap="2">
          <Button variant="secondary" onClick={() => navigate("/monitors")}>
            <ArrowLeftIcon />
          </Button>
          <Heading size="6">{t("monitor.form.title.create")}</Heading>
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
                        <TableCell></TableCell>
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
                              onClick={() => removeHeader(index)}
                            >
                              <TrashIcon />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  <Button
                    variant="secondary"
                    onClick={(e) => {
                      e.preventDefault();
                      setHeaders([...headers, { key: "", value: "" }]);
                    }}
                    className="mt-2"
                    type="button"
                  >
                    <PlusIcon />
                    {t("monitor.form.addHeader")}
                  </Button>
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

          <Flex justify="end" gap="2" className="ml-4">
            <Button variant="secondary" onClick={() => navigate("/monitors")}>
              {t("monitor.form.cancel")}
            </Button>
            <Button type="submit" disabled={loading} onClick={handleSubmit}>
              {loading ? t("monitor.form.creating") : t("monitor.form.create")}
            </Button>
          </Flex>
        </form>
      </Card>
    </Box>
  );
};

export default CreateMonitor;
