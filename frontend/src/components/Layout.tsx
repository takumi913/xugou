import { ReactNode } from "react";
import { Box, Flex, Text, Container, Theme } from "@/components/ui/theme-shim";
import { Separator, Button, Toaster } from "./ui";
import Navbar from "./Navbar";
import { Mail, Rss } from "lucide-react";
import { useTranslation } from "react-i18next";

interface LayoutProps {
  children: ReactNode;
}

const Layout = ({ children }: LayoutProps) => {
  const currentYear = new Date().getFullYear();
  const { t } = useTranslation();

  return (
    <Theme appearance="light">
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
              <Text size="2" color="gray">
                {t("footer.copyright", { year: currentYear })}
              </Text>
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
    </Theme>
  );
};

export default Layout;
