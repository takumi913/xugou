import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Flex, Heading, Text } from "@/components/ui/theme-shim";
import {
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Input,
} from "@/components/ui";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { createUser } from "../../api/users";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const CreateUser = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: "",
    password: "",
    email: "",
    role: "user",
  });
  const { t } = useTranslation();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleRoleChange = (value: string) => {
    setFormData((prev) => ({ ...prev, role: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await createUser(formData);

      if (response.success) {
        toast.success("用户创建成功");
        navigate("/users");
      } else {
        toast.error(response.message || "创建用户失败");
      }
    } catch {
      toast.error("创建用户失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="center">
        <Flex align="center" gap="2">
          <Button variant="secondary" onClick={() => navigate("/users")}>
            <ArrowLeftIcon />
          </Button>
          <Heading size="6">{t("users.create")}</Heading>
        </Flex>
      </Flex>
      <Card className="my-4 pr-4">
        <form onSubmit={handleSubmit}>
          <Box pt="2">
            <Flex direction="column" gap="3" className="ml-4">
              <Box>
                <Text as="label" size="2">
                  {t("user.username")} *
                </Text>
                <Input
                  className="h-10"
                  name="username"
                  value={formData.username}
                  onChange={handleChange}
                  placeholder={t("user.username")}
                  required
                />
              </Box>

              <Box>
                <Text as="label" size="2">
                  密码 *
                </Text>
                <Input
                  className="h-10"
                  name="password"
                  type="password"
                  value={formData.password}
                  onChange={handleChange}
                  placeholder="请输入密码"
                  required
                />
              </Box>

              <Box>
                <Text as="label" size="2">
                  {t("user.email")}
                </Text>
                <Input
                  className="h-10"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleChange}
                  placeholder={t("user.email")}
                />
              </Box>

              <Box>
                <Text as="label" size="2">
                  {t("user.role")} *
                </Text>
                <Select value={formData.role} onValueChange={handleRoleChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                  </SelectContent>
                </Select>
              </Box>

              <Flex justify="end" mt="4" gap="2">
                <Button variant="secondary" onClick={() => navigate("/users")}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? "创建中..." : t("users.create")}
                </Button>
              </Flex>
            </Flex>
          </Box>
        </form>
      </Card>
    </Box>
  );
};

export default CreateUser;
