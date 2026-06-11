import { useState, useEffect } from "react"; // 导入 useEffect
import { useNavigate, Link } from "react-router-dom";
import { Flex, Heading, Text } from "@/components/ui/theme-shim";
import { Button, Card, Input } from "@/components/ui"; // 导入 Input 组件
import { useAuth } from "../../providers/AuthProvider";
import { useTranslation } from "react-i18next";
import { getAllowNewUserRegistration } from "../../api/settings"; // 导入 API
import { toast } from "sonner"; // 导入 toast

const Register = () => {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const { register } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // 新增：检查注册是否开启
  useEffect(() => {
    const checkRegistrationStatus = async () => {
      try {
        const response = await getAllowNewUserRegistration();
        if (!response.success || !response.allow) {
          toast.error(t('register.disabled'));
          navigate("/login");
        }
      } catch {
        toast.error(t('register.disabled'));
        navigate("/login");
      }
    };
    checkRegistrationStatus();
  }, [navigate, t]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // 验证密码
    if (password !== confirmPassword) {
      setError(t("register.error.passwordMismatch"));
      return;
    }

    setIsLoading(true);

    try {
      const result = await register({ username, password, email });
      if (result.success) {
        navigate("/login", {
          state: { message: t("register.success.message") },
        });
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("register.error.usernameExists")
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="page-container">
      <Flex
        justify="center"
        align="center"
        style={{ minHeight: "calc(100vh - 130px)", padding: "2rem 0" }}
      >
        <Card style={{ width: "400px", padding: "2rem" }}>
          <Flex direction="column" gap="4">
            <Heading align="center" size="6">
              {t("register.title")}
            </Heading>

            {error && (
              <Text color="red" align="center">
                {error}
              </Text>
            )}

            <form onSubmit={handleSubmit}>
              <Flex direction="column" gap="3">
                <Input
                  placeholder={t("register.username")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />

                <Input
                  placeholder={t("register.email")}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />

                <Input
                  placeholder={t("register.password")}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />

                <Input
                  placeholder={t("register.confirmPassword")}
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />

                <Button type="submit" disabled={isLoading}>
                  {isLoading ? t("common.loading") : t("register.button")}
                </Button>
              </Flex>
            </form>

            <Text align="center" size="2">
              {t("register.loginLink")}{" "}
              <Link
                to="/login"
                style={{ color: "var(--accent-9)", textDecoration: "none" }}
              >
                {t("navbar.login")}
              </Link>
            </Text>
          </Flex>
        </Card>
      </Flex>
    </div>
  );
};

export default Register;
