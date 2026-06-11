import { Flex, Heading, Text } from "@/components/ui/theme-shim";
import { Button } from "@/components/ui";
import { Link } from "react-router-dom";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { useTranslation } from "react-i18next";

const NotFound = () => {
  const { t } = useTranslation();

  return (
    <div className="page-container">
      <Flex
        direction="column"
        align="center"
        justify="center"
        style={{ minHeight: "calc(100vh - 200px)" }}
        gap="4"
      >
        <ExclamationTriangleIcon
          width="48"
          height="48"
          color="var(--amber-9)"
        />
        <Heading size="9">404</Heading>
        <Heading size="6">{t("notFound.title")}</Heading>
        <Text align="center" style={{ maxWidth: "500px" }}>
          {t("notFound.message")}
        </Text>
        <Button asChild>
          <Link to="/">{t("notFound.button")}</Link>
        </Button>
      </Flex>
    </div>
  );
};

export default NotFound;
