import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { getUser, updateUser } from "../../api/users";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { User } from "@/types";

const EditUser = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    role: "user",
  });
  const { t } = useTranslation();

  useEffect(() => {
    if (id) {
      const fetchUserData = async () => {
        setLoading(true);
        const response = await getUser(Number(id));
        if (response.success && response.user) {
          setUser(response.user); // 保存原始用户信息
          setFormData({
            username: response.user.username,
            email: response.user.email || "",
            role: response.user.role || "user",
          });
        } else {
          toast.error(response.message || "获取用户信息失败");
        }
        setLoading(false);
      };
      fetchUserData();
    }
  }, [id]);

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
      const response = await updateUser(Number(id), formData);

      if (response.success) {
        toast.success("用户更新成功");
        navigate("/users");
      } else {
        toast.error(response.message || "更新用户失败");
      }
    } catch {
      toast.error("更新用户失败");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <Text>{t("common.loading")}</Text>;
  }

  return (
    <Box className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="center">
        <Flex align="center" gap="2">
          <Button variant="secondary" onClick={() => navigate("/users")}>
            <ArrowLeftIcon />
          </Button>
          <Heading size="6">
            {t("common.edit")} {t("users.title")}
          </Heading>
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
                <Select
                  value={formData.role}
                  onValueChange={handleRoleChange}
                  disabled={user?.role === "admin"}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* 如果是 admin，只显示 admin 选项，否则显示 manager 和 user */}
                    {user?.role === "admin" ? (
                      <SelectItem value="admin">Admin</SelectItem>
                    ) : (
                      <>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="user">User</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </Box>

              <Flex justify="end" mt="4" gap="2">
                <Button variant="secondary" onClick={() => navigate("/users")}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading
                    ? t("common.savingChanges")
                    : t("common.saveChanges")}
                </Button>
              </Flex>
            </Flex>
          </Box>
        </form>
      </Card>
    </Box>
  );
};

export default EditUser;
