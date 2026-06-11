import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom"; // 导入 Link
import { Flex, Heading, Text } from "@/components/ui/theme-shim";
import { Button, Card, Input } from "@/components/ui";
import { useAuth } from "../../providers/AuthProvider";
import { useTranslation } from "react-i18next";
import { getAllowNewUserRegistration } from "../../api/settings"; // 导入新的 API 函数

type LoginLocationState = {
  from?: {
    pathname?: string;
  };
  message?: string;
};

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [showRegister, setShowRegister] = useState(false); // 新增状态

  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const locationState = location.state as LoginLocationState | null;

  // 如果已登录，重定向到 dashboard 或原来要访问的页面
  useEffect(() => {
    if (isAuthenticated) {
      const from = locationState?.from?.pathname || "/dashboard";
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, locationState]);

  // 检查是否有来自注册页面的消息
  useEffect(() => {
    // 检查是否允许注册
    const checkRegistrationStatus = async () => {
      try {
        const response = await getAllowNewUserRegistration();
        if (response.success) {
          setShowRegister(response.allow);
        }
      } catch (e) {
        console.error("检查注册状态失败", e);
      }
    };
    checkRegistrationStatus();

    if (locationState?.message) {
      setMessage(locationState.message);
    }
  }, [locationState]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const result = await login({ username, password });
      if (result.success) {
        // 登录成功后，重定向到用户原来要访问的页面，或默认到 dashboard
        const from = locationState?.from?.pathname || "/dashboard";
        navigate(from, { replace: true });
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.error"));
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
              {t("login.title")}
            </Heading>

            {message && (
              <Text color="green" align="center">
                {message}
              </Text>
            )}

            {error && (
              <Text color="red" align="center">
                {error}
              </Text>
            )}

            <form onSubmit={handleSubmit}>
              <Flex direction="column" gap="3">
                <Input
                  placeholder={t("login.username")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="text-gray-900"
                />
                <Input
                  placeholder={t("login.password")}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="text-gray-900"
                />

                <Button type="submit" disabled={isLoading}>
                  {isLoading ? t("common.loading") : t("login.button")}
                </Button>
              </Flex>
            </form>

            {/* 新增：根据设置显示注册链接 */}
            {showRegister && (
              <Text align="center" size="2" className="mt-4">
                {t("login.registerLink")}{" "}
                <Link
                  to="/register"
                  style={{ color: "var(--accent-9)", textDecoration: "none" }}
                >
                  {t("navbar.register")}
                </Link>
              </Text>
            )}
          </Flex>
        </Card>
      </Flex>
    </div>
  );
};

export default Login;
