import { Button } from "@/components/ui";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

const NotFound = () => {
  const { t } = useTranslation();

  return (
    <div className="page-container">
      <div className="flex min-h-[calc(100vh-200px)] flex-col items-center justify-center gap-4 text-center">
        <p className="text-2xl font-semibold text-[var(--text-primary)]">
          <span className="text-[var(--accent-yellow)]">[!]</span> 404 -{" "}
          {t("notFound.title")}
        </p>
        <p className="max-w-[500px] text-[var(--text-secondary)]">
          {t("notFound.message")}
        </p>
        <Button asChild>
          <Link to="/">{t("notFound.button")}</Link>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;
