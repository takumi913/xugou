import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Flex, Text } from "@/components/ui/layout";
import { Button, Input } from "@/components/ui";
import { useAuth } from "../../providers/AuthProvider";
import { useTranslation } from "react-i18next";

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
        className="min-h-[calc(100vh-130px)] py-8"
      >
        <div className="terminal-card w-[400px] max-w-full p-8">
          <Flex direction="column" gap="4">
            <h1 className="prompt-title text-center">{t("login.title")}</h1>

            {message && (
              <Text align="center" className="text-[var(--accent-green)]">
                {message}
              </Text>
            )}

            {error && (
              <Text align="center" className="text-[var(--accent-red)]">
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
                />
                <Input
                  placeholder={t("login.password")}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />

                <Button type="submit" disabled={isLoading}>
                  {isLoading ? t("common.loading") : t("login.button")}
                </Button>
              </Flex>
            </form>

          </Flex>
        </div>
      </Flex>
    </div>
  );
};

export default Login;
