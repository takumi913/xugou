import { Box, Flex, Heading, Text, Grid } from "@/components/ui/theme-shim";
import { Button, Card } from "@/components/ui";
import { Link } from "react-router-dom";
import {
  ActivityLogIcon,
  LightningBoltIcon,
  MixerHorizontalIcon,
  DesktopIcon,
  GitHubLogoIcon,
} from "@radix-ui/react-icons";
import { useAuth } from "../providers/AuthProvider";
import { useTranslation } from "react-i18next";

const Home = () => {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();

  return (
    <Box>
      <div className="page-container">
        {/* 英雄区域 */}
        <Flex direction="column" align="center" justify="center" py="9" gap="5">
          <Heading size="9" align="center">
            {t("home.title")}
          </Heading>
          <Text size="5" align="center" style={{ maxWidth: "800px" }}>
            {t("home.subtitle")}
          </Text>

          {/* GitHub 图标 */}
          <Flex justify="center" py="2">
            <GitHubLogoIcon width="32" height="32" />
          </Flex>

          <Flex gap="4" mt="4">
            {isAuthenticated ? (
              <>
                <Button asChild>
                  <Link to="/dashboard">{t("home.getStarted")}</Link>
                </Button>
              </>
            ) : (
              <>
                <Button asChild>
                  <Link to="/login">{t("home.getStarted")}</Link>
                </Button>
                <Button asChild>
                  <a
                    href="https://github.com/zaunist/xugou"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("home.learnMore")}
                  </a>
                </Button>
              </>
            )}
          </Flex>
        </Flex>

        {/* 特性区域 */}
        <Box py="9">
          <Heading size="6" mb="6" align="center">
            {t("home.features.title")}
          </Heading>
          <Grid columns={{ initial: "1", sm: "2", md: "4" }} gap="4">
            <Card>
              <Flex direction="column" gap="2" align="center" p="4">
                <ActivityLogIcon width="32" height="32" />
                <Heading size="4">{t("home.features.monitoring")}</Heading>
                <Text align="center">{t("home.features.monitoring.desc")}</Text>
              </Flex>
            </Card>
            <Card>
              <Flex direction="column" gap="2" align="center" p="4">
                <DesktopIcon width="32" height="32" />
                <Heading size="4">{t("home.features.dashboard")}</Heading>
                <Text align="center">{t("home.features.dashboard.desc")}</Text>
              </Flex>
            </Card>
            <Card>
              <Flex direction="column" gap="2" align="center" p="4">
                <LightningBoltIcon width="32" height="32" />
                <Heading size="4">{t("home.features.alerts")}</Heading>
                <Text align="center">{t("home.features.alerts.desc")}</Text>
              </Flex>
            </Card>
            <Card>
              <Flex direction="column" gap="2" align="center" p="4">
                <MixerHorizontalIcon width="32" height="32" />
                <Heading size="4">{t("home.features.statusPage")}</Heading>
                <Text align="center">{t("home.features.statusPage.desc")}</Text>
              </Flex>
            </Card>
          </Grid>
        </Box>
      </div>
    </Box>
  );
};

export default Home;
