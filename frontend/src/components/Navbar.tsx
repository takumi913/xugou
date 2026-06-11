import { Link, useNavigate, useLocation } from "react-router-dom";
import { Box, Flex, Text, Container } from "@/components/ui/theme-shim";
import {
  Separator,
  Button,
  Avatar,
  AvatarImage,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui";
import {
  ExitIcon,
  PersonIcon,
  PersonIcon as UserIcon,
  DashboardIcon,
  ChevronDownIcon,
  ActivityLogIcon,
  CubeIcon,
  PieChartIcon,
  BellIcon,
  HamburgerMenuIcon,
  DownloadIcon,
} from "@radix-ui/react-icons";
import { useAuth } from "../providers/AuthProvider";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import LanguageSelector from "./LanguageSelector";
import { promptPWAInstall } from "@/utils/pwaInstallHandler";

const Navbar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, logout } = useAuth();
  const [isScrolled, setIsScrolled] = useState(false);
  const { t } = useTranslation();

  // 监听滚动事件
  useEffect(() => {
    const handleScroll = () => {
      const scrollPosition = window.scrollY;
      if (scrollPosition > 10) {
        setIsScrolled(true);
      } else {
        setIsScrolled(false);
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const isActive = (path: string) => {
    return (
      location.pathname === path || location.pathname.startsWith(`${path}/`)
    );
  };

  return (
    <Box className={`navbar-wrapper ${isScrolled ? "scrolled" : ""}`}>
      <Box>
        <Container size="4">
          <Flex justify="between" align="center" py="2">
            <Flex gap="2" align="center">
              {/* 移动端屏幕菜单栏 */}
              {isAuthenticated ? (
                <>
                  <Box className="lg:hidden">
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Flex className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                          <HamburgerMenuIcon width="20" height="20" />
                        </Flex>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          onClick={() => navigate("/dashboard")}
                        >
                          <Flex gap="2" align="center">
                            <DashboardIcon width="14" height="14" />
                            <Text className="pl-2" size="2">
                              {t("navbar.dashboard")}
                            </Text>
                          </Flex>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate("/monitors")}>
                          <Flex gap="2" align="center">
                            <ActivityLogIcon width="14" height="14" />
                            <Text className="pl-2" size="2">
                              {t("navbar.apiMonitors")}
                            </Text>
                          </Flex>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate("/agents")}>
                          <Flex gap="2" align="center">
                            <CubeIcon width="14" height="14" />
                            <Text className="pl-2" size="2">
                              {t("navbar.agentMonitors")}
                            </Text>
                          </Flex>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => navigate("/status/config")}
                        >
                          <Flex gap="2" align="center">
                            <PieChartIcon width="14" height="14" />
                            <Text className="pl-2" size="2">
                              {t("navbar.statusPage")}
                            </Text>
                          </Flex>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => navigate("/notifications")}
                        >
                          <Flex gap="2" align="center">
                            <BellIcon width="14" height="14" />
                            <Text className="pl-2" size="2">
                              {t("navbar.notifications")}
                            </Text>
                          </Flex>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={promptPWAInstall}>
                          <Flex gap="2" align="center">
                            <DownloadIcon width="14" height="14" />
                            <Text className="pl-2" size="2">
                              {t("navbar.installApp")}
                            </Text>
                          </Flex>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Box>

                  <Separator
                    orientation="vertical"
                    className="!h-6 lg:hidden"
                  />
                </>
              ) : null}

              {/* Logo 部分 */}
              <Flex align="center" className="ml-3">
                <Link to="/">
                  <Flex align="center" gap="2">
                    <Box>
                      <PieChartIcon width="20" height="20" />
                    </Box>
                    <Text size="4" weight="bold">
                      XUGOU
                    </Text>
                  </Flex>
                </Link>
              </Flex>
            </Flex>

            {/* 导航链接 */}
            <Flex align="center" gap="2">
              {isAuthenticated ? (
                <>
                  {/* 普通屏幕菜单栏 */}
                  <Flex align="center" display={{ initial: "none", md: "flex" }}>
                    <Link
                      to="/dashboard"
                      className={`nav-link ${
                        isActive("/dashboard") ? "active" : ""
                      }`}
                    >
                      <Button variant="ghost">
                        <DashboardIcon width="14" height="14" />
                        <Text ml="1" size="2">
                          {t("navbar.dashboard")}
                        </Text>
                      </Button>
                    </Link>

                    <Link
                      to="/monitors"
                      className={`nav-link ${
                        isActive("/monitors") ? "active" : ""
                      }`}
                    >
                      <Button variant="ghost">
                        <ActivityLogIcon width="14" height="14" />
                        <Text ml="1" size="2">
                          {t("navbar.apiMonitors")}
                        </Text>
                      </Button>
                    </Link>

                    <Link
                      to="/agents"
                      className={`nav-link ${
                        isActive("/agents") ? "active" : ""
                      }`}
                    >
                      <Button variant="ghost">
                        <CubeIcon width="14" height="14" />
                        <Text ml="1" size="2">
                          {t("navbar.agentMonitors")}
                        </Text>
                      </Button>
                    </Link>

                    <Link
                      to="/status/config"
                      className={`nav-link ${
                        isActive("/status/config") ? "active" : ""
                      }`}
                    >
                      <Button variant="ghost">
                        <PieChartIcon width="14" height="14" />
                        <Text ml="1" size="2">
                          {t("navbar.statusPage")}
                        </Text>
                      </Button>
                    </Link>

                    <Link
                      to="/notifications"
                      className={`nav-link ${
                        isActive("/notifications") ? "active" : ""
                      }`}
                    >
                      <Button variant="ghost">
                        <BellIcon width="14" height="14" />
                        <Text ml="1" size="2">
                          {t("navbar.notifications")}
                        </Text>
                      </Button>
                    </Link>

                    <Button onClick={promptPWAInstall} variant="ghost">
                      <Flex gap="1" align="center">
                        <DownloadIcon width="14" height="14" />
                        <Text className="pl-2" size="2">
                          {t("navbar.installApp")}
                        </Text>
                      </Flex>
                    </Button>
                  </Flex>

                  <Separator
                    orientation="vertical"
                    className="!h-6 hidden lg:block"
                  />

                  {/* 语言选择器 */}
                  <LanguageSelector />

                  <Separator orientation="vertical" className="!h-6" />

                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <Flex
                        align="center"
                        gap="1"
                        className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <Avatar className="border">
                          <AvatarImage
                            src=""
                            alt={user?.username}
                            width="32"
                            height="32"
                          />
                          <AvatarFallback>
                            {user?.username ? (
                              user.username.charAt(0).toUpperCase()
                            ) : (
                              <PersonIcon />
                            )}
                          </AvatarFallback>
                        </Avatar>
                        <Box display={{ initial: "none", sm: "block" }}>
                          <Text size="2">{user?.username}</Text>
                        </Box>
                        <ChevronDownIcon width="12" height="12" />
                      </Flex>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="user-dropdown">
                      <DropdownMenuLabel>
                        <Text size="1" color="gray">
                          {t("navbar.loggedInAs")}
                        </Text>
                        <Text size="2" weight="bold">
                          {user?.username}
                        </Text>
                      </DropdownMenuLabel>

                      <DropdownMenuSeparator />

                      {user?.role === "admin" && (
                        <DropdownMenuItem onClick={() => navigate("/users")}>
                          <Flex gap="2" align="center">
                            <UserIcon width="14" height="14" />
                            <Text size="2">{t("navbar.userManagement")}</Text>
                          </Flex>
                        </DropdownMenuItem>
                      )}

                      <DropdownMenuItem onClick={() => navigate("/profile")}>
                        <Flex gap="2" align="center">
                          <PersonIcon width="14" height="14" />
                          <Text size="2">{t("navbar.profile")}</Text>
                        </Flex>
                      </DropdownMenuItem>

                      <DropdownMenuSeparator />

                      <DropdownMenuItem color="red" onClick={handleLogout}>
                        <Flex gap="2" align="center">
                          <ExitIcon width="14" height="14" />
                          <Text size="2">{t("navbar.logout")}</Text>
                        </Flex>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : (
                <Flex gap="2" align="center">
                  {/* 语言选择器 */}
                  <LanguageSelector />

                  <Separator orientation="vertical" className="!h-6" />

                  <Button variant="ghost" onClick={() => navigate("/login")}>
                    {t("navbar.login")}
                  </Button>
                </Flex>
              )}
            </Flex>
          </Flex>
        </Container>
      </Box>
    </Box>
  );
};

export default Navbar;