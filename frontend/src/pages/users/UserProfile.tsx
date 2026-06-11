import { useState, useEffect } from "react";
import { Flex, Heading, Text, Box } from "@/components/ui/theme-shim";
import { Button, Card, Input } from "@/components/ui";
import { useAuth } from "../../providers/AuthProvider";
import { updateUser, changePassword, getUser } from "../../api/users";
import { UpdateUserRequest, ChangePasswordRequest } from "../../types/users";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const UserProfile = () => {
  const { user } = useAuth();
  const { t } = useTranslation();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [isPasswordLoading, setIsPasswordLoading] = useState(false);

  useEffect(() => {
    if (user) {
      // 获取完整的用户信息，包括电子邮件
      const fetchUserData = async () => {
        const response = await getUser(user.id);
        if (response.success && response.user) {
          setUsername(response.user.username);
          setEmail(response.user.email || "");
        }
      };
      fetchUserData();
    }
  }, [user]);

  const handleProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProfileLoading(true);

    if (!user) {
      toast.error(t("profile.error.notLoggedIn"));
      setIsProfileLoading(false);
      return;
    }

    const data: UpdateUserRequest = {
      username,
      email: email || undefined,
    };

    try {
      const response = await updateUser(user.id, data);
      if (response.success) {
        toast.success(t("profile.success.updated"));
      } else {
        toast.error(response.message || t("profile.error.update"));
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("profile.error.update")
      );
    } finally {
      setIsProfileLoading(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      toast.error(t("profile.error.notLoggedIn"));
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error(t("profile.error.passwordMismatch"));
      return;
    }

    setIsPasswordLoading(true);

    const data: ChangePasswordRequest = {
      currentPassword,
      newPassword,
    };

    try {
      const response = await changePassword(user.id, data);
      if (response.success) {
        toast.success(t("profile.success.passwordChanged"));
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        toast.error(response.message || t("profile.error.passwordChange"));
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("profile.error.passwordChange")
      );
    } finally {
      setIsPasswordLoading(false);
    }
  };

  if (!user) {
    return <Text>{t("common.loading")}</Text>;
  }

  return (
    <Box className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="center">
        <Heading size="6">{t("profile.title")}</Heading>
      </Flex>

      <Flex direction="column" gap="6" className="mt-4 mb-4">
        <Card>
          <Heading size="4" mb="4" className="ml-4">
            {t("profile.basicInfo")}
          </Heading>

          <form onSubmit={handleProfileUpdate}>
            <Flex direction="column" gap="3" className="ml-4">
              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  {t("user.username")}
                </Text>
                <Input
                  className="h-10"
                  value={username}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setUsername(e.target.value)
                  }
                  required
                />
              </Flex>

              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  {t("user.email")}
                </Text>
                <Input
                  className="h-10"
                  type="email"
                  value={email}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEmail(e.target.value)
                  }
                />
              </Flex>

              <Button type="submit" disabled={isProfileLoading}>
                {isProfileLoading
                  ? t("common.savingChanges")
                  : t("profile.update")}
              </Button>
            </Flex>
          </form>
        </Card>

        <Card>
          <Heading size="4" mb="4">
            {t("profile.changePassword")}
          </Heading>

          <form onSubmit={handlePasswordChange}>
            <Flex direction="column" gap="3" className="ml-4">
              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  {t("profile.currentPassword")}
                </Text>
                <Input
                  className="h-10"
                  type="password"
                  value={currentPassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setCurrentPassword(e.target.value)
                  }
                  required
                />
              </Flex>

              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  {t("profile.newPassword")}
                </Text>
                <Input
                  className="h-10"
                  type="password"
                  value={newPassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setNewPassword(e.target.value)
                  }
                  required
                />
              </Flex>

              <Flex direction="column" gap="1">
                <Text size="2" weight="medium">
                  {t("profile.confirmNewPassword")}
                </Text>
                <Input
                  className="h-10"
                  type="password"
                  value={confirmPassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setConfirmPassword(e.target.value)
                  }
                  required
                />
              </Flex>

              <Button type="submit" disabled={isPasswordLoading}>
                {isPasswordLoading
                  ? t("common.savingChanges")
                  : t("profile.changePasswordButton")}
              </Button>
            </Flex>
          </form>
        </Card>
      </Flex>
    </Box>
  );
};

export default UserProfile;
