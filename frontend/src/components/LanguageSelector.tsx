import React from "react";
import { Text, Flex } from "@/components/ui/theme-shim";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui";
import { GlobeIcon, CheckIcon } from "@radix-ui/react-icons";
import { useLanguage } from "../providers/LanguageProvider";
import { useTranslation } from "react-i18next";

const LanguageSelector: React.FC = () => {
  const { currentLanguage, changeLanguage, availableLanguages } = useLanguage();
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Flex
          align="center"
          gap="1"
          className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <GlobeIcon width="14" height="14" />
          <Text size="2" className="hidden sm:block">
            {currentLanguage === "zh-CN" ? "中文" : "English"}
          </Text>
        </Flex>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {availableLanguages.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => changeLanguage(lang.code)}
          >
            <Flex
              gap="2"
              align="center"
              justify="between"
              style={{ width: "100%" }}
            >
              <Text size="2">
                {t(`language.${lang.code.replace("-", "")}`)}
              </Text>
              {currentLanguage === lang.code && (
                <CheckIcon width="14" height="14" />
              )}
            </Flex>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default LanguageSelector;
