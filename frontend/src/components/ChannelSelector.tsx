import { useState, useRef, useEffect } from "react";
import { Box, Flex, Text } from "@/components/ui/theme-shim";
import { CheckIcon } from "@radix-ui/react-icons";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChannelSelectorProps } from "@/types/components";

/**
 * 通知渠道选择器组件
 *
 * 提供多选下拉框方式选择通知渠道
 *
 * @param props.channels 可选择的通知渠道列表
 * @param props.selectedChannelIds 已选择的渠道ID数组
 * @param props.onChange 选择变更时的回调函数
 * @param props.placeholder 占位文本
 */
const ChannelSelector = ({
  channels,
  selectedChannelIds,
  onChange,
  placeholder,
}: ChannelSelectorProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const selectContentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  // 显示已选择的渠道名称
  const getSelectedText = () => {
    if (selectedChannelIds.length === 0) {
      return placeholder || t("notifications.channels.selectChannels");
    }

    if (selectedChannelIds.length === 1) {
      const channel = channels.find((c) => c.id === selectedChannelIds[0]);
      return channel
        ? channel.name
        : placeholder || t("notifications.channels.selectChannels");
    }

    return `${selectedChannelIds.length} ${t(
      "notifications.channels.selected"
    )}`;
  };

  // 处理选项点击
  const handleItemClick = (channelId: number) => {
    // 切换选择状态
    const isSelected = selectedChannelIds.includes(channelId);
    const newSelectedIds = isSelected
      ? selectedChannelIds.filter((id) => id !== channelId)
      : [...selectedChannelIds, channelId];

    onChange(newSelectedIds);
    // 不关闭下拉框
  };

  // 点击外部时关闭下拉框
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        selectContentRef.current &&
        !selectContentRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // 计算下拉框位置
  const getDropdownPosition = () => {
    if (!triggerRef.current) return { top: 0, left: 0, width: 0 };

    const rect = triggerRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + window.scrollY + 5, // 下方间距5px
      left: rect.left + window.scrollX,
      width: rect.width,
    };
  };

  const position = getDropdownPosition();

  return (
    <div>
      <Box
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        style={{
          borderRadius: "6px",
          border: "1px solid var(--gray-7)",
          padding: "8px 12px",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: "white",
          width: "100%",
        }}
      >
        <Text>{getSelectedText()}</Text>
        <div
          style={{
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "5px solid var(--gray-11)",
            marginLeft: "8px",
          }}
        ></div>
      </Box>

      {isOpen &&
        createPortal(
          <Box
            ref={selectContentRef}
            style={{
              position: "absolute",
              top: `${position.top}px`,
              left: `${position.left}px`,
              width: `${position.width}px`,
              backgroundColor: "white",
              border: "1px solid var(--gray-6)",
              borderRadius: "6px",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
              zIndex: 9999,
              maxHeight: "250px",
              overflowY: "auto",
            }}
          >
            {channels.length === 0 ? (
              <Box p="2">
                <Text color="gray">
                  {t("notifications.channels.noChannels")}
                </Text>
              </Box>
            ) : (
              <>
                {channels.map((channel) => (
                  <Box
                    key={channel.id}
                    onClick={() => handleItemClick(channel.id)}
                    style={{
                      padding: "8px 12px",
                      cursor: "pointer",
                      borderBottom: "1px solid var(--gray-4)",
                      backgroundColor: "white",
                    }}
                    onMouseOver={(e: React.MouseEvent<HTMLDivElement>) => {
                      e.currentTarget.style.backgroundColor = "var(--gray-3)";
                    }}
                    onMouseOut={(e: React.MouseEvent<HTMLDivElement>) => {
                      e.currentTarget.style.backgroundColor = "white";
                    }}
                  >
                    <Flex justify="between" align="center" width="100%">
                      <Flex gap="1" align="center">
                        <Text>{channel.name}</Text>
                        <Text size="1" color="gray">
                          ({t(`notifications.channels.type.${channel.type}`)})
                        </Text>
                      </Flex>
                      {selectedChannelIds.includes(channel.id) && <CheckIcon />}
                    </Flex>
                  </Box>
                ))}
              </>
            )}
          </Box>,
          document.body
        )}
    </div>
  );
};

export default ChannelSelector;
