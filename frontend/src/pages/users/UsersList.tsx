import { useState, useEffect } from "react";
import { Table, Text, Flex, Heading, Box } from "@/components/ui/theme-shim";
import {
  Button,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertDialogAction,
  Card, // 导入 Card
  Switch, // 导入 Switch
} from "@/components/ui";
import { getAllUsers, deleteUser } from "../../api/users";
import { getAllSettings, updateAllowNewUserRegistration } from "../../api/settings"; // 导入 settings API
import { User } from "../../types";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../../providers/AuthProvider"; // 导入 useAuth

const UsersList = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [allowRegistration, setAllowRegistration] = useState(false); // 新增状态
  const [settingsLoading, setSettingsLoading] = useState(true); // 新增加载状态

  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user: currentUser } = useAuth(); // 获取当前登录用户

  useEffect(() => {
    fetchUsers();
    if (currentUser?.role === 'admin') {
      fetchSettings(); // 获取设置
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await getAllUsers();
      if (response.success && response.users) {
        setUsers(response.users);
      } else {
        setError(response.message || t("users.error.fetch"));
        toast.error(response.message || t("users.error.fetch"));
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : t("users.error.fetch");
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // 获取设置
  const fetchSettings = async () => {
    setSettingsLoading(true);
    try {
      const response = await getAllSettings();
      if (response.success && response.settings) {
        setAllowRegistration(response.settings.allow_new_user_registration === 'true');
      }
    } catch (e) {
      console.error("Failed to fetch settings", e);
      toast.error("获取应用设置失败");
    } finally {
      setSettingsLoading(false);
    }
  };


  // 修复：直接将要删除的ID作为参数传入，避免状态更新延迟问题
  const handleDelete = async (id: number) => {
    try {
      const response = await deleteUser(id);
      if (response.success) {
        // 更新前端UI，直接移除被删除的用户
        setUsers(users.filter((user) => user.id !== id));
        toast.success(response.message || "用户删除成功");
      } else {
        setError(response.message || t("users.error.delete"));
        toast.error(response.message || t("users.error.delete"));
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : t("users.error.delete");
      setError(errorMessage);
      toast.error(errorMessage);
    }
  };

  // 处理注册开关切换
  const handleRegistrationToggle = async (checked: boolean) => {
    setAllowRegistration(checked);
    try {
      const response = await updateAllowNewUserRegistration(checked);
      if(response.success) {
          toast.success(response.message);
      } else {
          toast.error(response.message);
          setAllowRegistration(!checked); // 失败时回滚状态
      }
    } catch {
        toast.error("更新设置失败");
        setAllowRegistration(!checked); // 失败时回滚状态
    }
  }

  return (
    <Box className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="center" mb="4">
        <Heading size="6">{t("users.title")}</Heading>
        <Button variant="secondary" onClick={() => navigate("/users/create")}>
          {t("users.create")}
        </Button>
      </Flex>
      
      {/* 管理员设置 */}
      {currentUser?.role === 'admin' && (
        <Card className="my-4 p-4">
            <Flex justify="between" align="center">
                <Box>
                    <Text as="label" htmlFor="allow-registration-switch" className="font-medium">
                        {t('users.allowRegistration')}
                    </Text>
                    <Text as="p" size="2" color="gray">
                        {t('users.allowRegistrationHelp')}
                    </Text>
                </Box>
                <Switch
                    id="allow-registration-switch"
                    checked={allowRegistration}
                    onCheckedChange={handleRegistrationToggle}
                    disabled={settingsLoading}
                />
            </Flex>
        </Card>
      )}


      {/* 错误信息现在通过 toast 显示，如果需要也可以保留这里的 Text 组件 */}
      {error && (
        <Text color="red" mb="4">
          {`错误: ${error}`}
        </Text>
      )}

      {loading ? (
        <Text>{t("common.loading")}</Text>
      ) : (
        <Table.Root variant="surface">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>ID</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>
                {t("user.username")}
              </Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>{t("user.email")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>{t("user.role")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>
                {t("common.actions")}
              </Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>

          <Table.Body>
            {users.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={5}>
                  <Text align="center">{t("users.noUsers")}</Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              users.map((user) => (
                <Table.Row key={user.id}>
                  <Table.Cell>{user.id}</Table.Cell>
                  <Table.Cell>{user.username}</Table.Cell>
                  <Table.Cell>{user.email || "-"}</Table.Cell>
                  <Table.Cell>{user.role}</Table.Cell>
                  <Table.Cell>
                    <Flex gap="2">
                      <Button
                        variant="secondary"
                        onClick={() => navigate(`/users/${user.id}`)}
                      >
                        {t("common.edit")}
                      </Button>
                      {user.role !== "admin" && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="secondary">
                              {t("common.delete")}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogTitle>
                              {t("common.deleteConfirmation")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("users.deleteConfirm", {
                                username: user.username,
                              })}
                            </AlertDialogDescription>
                            <Flex gap="3" mt="4" justify="end">
                              <AlertDialogCancel>
                                {t("common.cancel")}
                              </AlertDialogCancel>
                              {/* 修复：直接在 onClick 中调用 handleDelete 并传入 user.id */}
                              <AlertDialogAction
                                onClick={() => handleDelete(user.id)}
                              >
                                {t("common.delete")}
                              </AlertDialogAction>
                            </Flex>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      )}
    </Box>
  );
};

export default UsersList;
