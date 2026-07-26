import { ReactNode, useEffect, useState } from "react";
import { Box, Flex, Text, Container } from "@/components/ui/theme-shim";
import { Separator, Button, Toaster } from "./ui";
import Navbar from "./Navbar";
import { Mail, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "../config";
import { checkForNewVersion } from "../utils/version";

interface LayoutProps {
  children: ReactNode;
}

const Layout = ({ children }: LayoutProps) => {
  const currentYear = new Date().getFullYear();
  const { t } = useTranslation();
  // 有新版时为远端 tag（如 "v1.2.0"），否则为 null
  const [newVersion, setNewVersion] = useState<string | null>(null);

  // 新版检测：每 24h（localStorage 节流）请求 GitHub releases API，失败静默
  useEffect(() => {
    let cancelled = false;
    checkForNewVersion(APP_VERSION).then((latest) => {
      if (!cancelled && latest) {
        setNewVersion(latest);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Flex direction="column" className="min-h-[100vh]">
      {/* 顶部导航栏 */}
      <Navbar />

      {/* 主要内容 */}
      <Box className="grow px-2">{children}</Box>

      {/* 页脚 */}
      <Box>
        <Container>
          <Separator color="gray" />
          <Flex justify="center" align="center" py="3" direction="column">
            <Flex align="center" gap="2">
              <Text size="2" color="gray">
                {t("footer.copyright", { year: currentYear })}
              </Text>
              <span
                className="footer-version"
                title={
                  newVersion
                    ? t("footer.newVersion", { version: newVersion })
                    : undefined
                }
              >
                v{APP_VERSION}
                {newVersion && <span className="footer-version-dot" />}
              </span>
            </Flex>
            <Flex gap="3" mt="2" direction={{ initial: "column", sm: "row" }}>
              <Button variant="link" asChild>
                <a
                  href="https://ajielu.vercel.app"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Rss className="size-4" />
                  <Text size="2">{t("footer.blog")}</Text>
                </a>
              </Button>
              <Button variant="link" asChild>
                <a
                  href="https://mail.mdzz.uk"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Mail className="size-4" />
                  <Text size="2">{t("footer.tempMail")}</Text>
                </a>
              </Button>
            </Flex>
          </Flex>
        </Container>
      </Box>
      <Toaster />
    </Flex>
  );
};

export default Layout;
