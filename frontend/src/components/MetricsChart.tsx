import React, {
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
} from "react";
import { Box, Flex } from "@/components/ui/theme-shim";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectItem,
  SelectValue, // 添加 SelectValue 到导入列表
} from "./ui";
import { useTranslation } from "react-i18next";
import { Line } from "react-chartjs-2";
import { MetricHistory, MetricType } from "../types";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip as ChartTooltip,
  Legend,
  ChartOptions,
  TooltipItem,
} from "chart.js";

// 注册Chart.js组件
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  ChartTooltip,
  Legend
);

// 数据点接口
interface DataPoint {
  x: number; // 时间戳（毫秒）
  y: number; // 指标值
  originalValue?: number; // 原始值，用于在tooltip中显示
  originalMetric?: ParsedMetricHistory; // 原始指标完整数据
  originalIndex?: number; // 原始数据索引
}

interface DiskMetric {
  device: string;
  mount_point: string;
  total: number;
  used: number;
  free: number;
  usage_rate: number;
  fs_type: string;
}

interface NetworkMetric {
  interface: string;
  bytes_sent: number;
  bytes_recv: number;
  packets_sent: number;
  packets_recv: number;
}

interface DeviceOption {
  value: string;
  label: string;
}

interface ParsedMetricHistory extends MetricHistory {
  parsedDiskMetrics: DiskMetric[];
  parsedNetworkMetrics: NetworkMetric[];
}

interface MetricsChartProps {
  history?: MetricHistory[];
  metricType: MetricType;
  height?: number;
  showTimeLabels?: boolean;
  diskDevice?: string; // 用于选择特定的磁盘设备（可选，如果不提供则使用默认值）
  networkInterface?: string; // 用于选择特定的网络接口（可选，如果不提供则使用默认值）
  loadType?: "1" | "5" | "15"; // 负载类型：1分钟、5分钟、15分钟
}

// 格式化字节数为可读形式
const formatBytes = (bytes: number | undefined, decimals = 2): string => {
  if (bytes === undefined || bytes === 0) return "0 B";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

const parseMetricArray = <T,>(value?: string): T[] => {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const MetricsChart: React.FC<MetricsChartProps> = ({
  history = [],
  metricType,
  height = 200,
  showTimeLabels = true,
  diskDevice,
  networkInterface,
  loadType = "1",
}) => {
  const { t } = useTranslation();
  const chartRef = useRef<ChartJS<"line">>(null);

  // 获取磁盘和网络设备列表并管理选中的设备
  const [availableDiskDevices, setAvailableDiskDevices] = useState<
    DeviceOption[]
  >([]);
  const [availableNetworkInterfaces, setAvailableNetworkInterfaces] = useState<
    DeviceOption[]
  >([]);
  const [selectedDiskDevice, setSelectedDiskDevice] = useState<string>(
    diskDevice || "/"
  );
  const [selectedNetworkInterface, setSelectedNetworkInterface] =
    useState<string>(networkInterface || "en0");
  const [selectedNetworkMetric, setSelectedNetworkMetric] = useState<
    "received" | "sent"
  >("received");
  // 添加 load 类型状态
  const [selectedLoadType, setSelectedLoadType] = useState<"1" | "5" | "15">(
    loadType || "1"
  );

  const parsedHistory = useMemo<ParsedMetricHistory[]>(
    () =>
      history.map((item) => ({
        ...item,
        parsedDiskMetrics: parseMetricArray<DiskMetric>(item.disk_metrics),
        parsedNetworkMetrics: parseMetricArray<NetworkMetric>(
          item.network_metrics
        ),
      })),
    [history]
  );

  // 从历史数据中提取可用的磁盘设备和网络接口
  useEffect(() => {
    if (parsedHistory.length === 0) return;

    // 提取所有可用的磁盘设备
    const disks = new Map<string, { device: string; mount_point: string }>();
    // 提取所有可用的网络接口
    const networks = new Map<string, string>();

    parsedHistory.forEach((item) => {
      // 处理磁盘信息
      item.parsedDiskMetrics.forEach((disk) => {
        disks.set(disk.mount_point, {
          device: disk.device,
          mount_point: disk.mount_point,
        });
      });

      // 处理网络信息
      item.parsedNetworkMetrics.forEach((network) => {
        networks.set(network.interface, network.interface);
      });
    });

    // 转换为选项数组
    const diskOptions: DeviceOption[] = Array.from(disks.values()).map(
      (disk) => ({
        value: disk.mount_point,
        label: `${disk.device} (${disk.mount_point})`,
      })
    );

    const networkOptions: DeviceOption[] = Array.from(networks.values()).map(
      (network) => ({
        value: network,
        label: network,
      })
    );

    setAvailableDiskDevices(diskOptions);
    setAvailableNetworkInterfaces(networkOptions);

    // 如果当前选择的设备不在列表中，则选择第一个可用设备
    if (
      diskOptions.length > 0 &&
      !diskOptions.some((option) => option.value === selectedDiskDevice)
    ) {
      setSelectedDiskDevice(diskOptions[0].value);
    }

    if (
      networkOptions.length > 0 &&
      !networkOptions.some(
        (option) => option.value === selectedNetworkInterface
      )
    ) {
      setSelectedNetworkInterface(networkOptions[0].value);
    }
  }, [parsedHistory, selectedDiskDevice, selectedNetworkInterface]);

  // 格式化时间的函数
  const formatTime = useCallback((date: Date) => {
    try {
      // 检查日期是否有效
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        return "无效日期";
      }

      // 统一使用本地时间格式
      const options: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false, // 使用24小时制
      };

      return date.toLocaleString(undefined, options);
    } catch (e) {
      console.error("格式化日期失败:", e);
      return "无效日期";
    }
  }, []);

  // 获取指标显示名称及单位
  const getMetricConfig = useCallback(
    (type: MetricType) => {
      switch (type) {
        case "cpu":
          return {
            title: t("agent.metrics.cpu.title"),
            unit: "%",
            color: "rgba(54, 162, 235, 0.8)",
            bgColor: "rgba(54, 162, 235, 0.1)",
          };
        case "memory":
          return {
            title: t("agent.metrics.memory.title"),
            unit: "%",
            color: "rgba(255, 99, 132, 0.8)",
            bgColor: "rgba(255, 99, 132, 0.1)",
          };
        case "disk":
          return {
            title: t("agent.metrics.disk.title"),
            unit: "%",
            color: "rgba(75, 192, 192, 0.8)",
            bgColor: "rgba(75, 192, 192, 0.1)",
          };
        case "network":
          return {
            title:
              selectedNetworkMetric === "received"
                ? t("agent.metrics.network.received")
                : t("agent.metrics.network.sent"),
            unit: "B/s", // 修改为基本单位 B/s，在 scales.y.ticks.callback 中会根据实际值动态调整显示
            color: "rgba(153, 102, 255, 0.8)",
            bgColor: "rgba(153, 102, 255, 0.1)",
          };
        case "load":
          return {
            title: `(${selectedLoadType}${t("agent.metrics.load.minute")})${t(
              "agent.metrics.load.title"
            )}`,
            unit: "",
            color: "rgba(34, 33, 32, 0.8)",
            bgColor: "rgba(255, 159, 64, 0.1)",
          };
        default:
          return {
            title: t("agent.metrics.unknown"),
            unit: "",
            color: "rgba(128, 128, 128, 0.8)",
            bgColor: "rgba(128, 128, 128, 0.1)",
          };
      }
    },
    [t, selectedLoadType, selectedNetworkMetric]
  );

  // 根据指标类型获取数据点的显示格式
  const getValueDisplayText = useCallback((type: MetricType, value: number) => {
    switch (type) {
      case "cpu":
      case "memory":
      case "disk":
        return `${Math.round(value * 100) / 100}%`;
      case "network":
        // 根据大小自动选择合适的单位
        if (value < 1024) {
          return `${Math.round(value)} B/s`;
        } else if (value < 1024 * 1024) {
          return `${Math.round((value / 1024) * 100) / 100} KB/s`;
        } else {
          return `${Math.round((value / 1024 / 1024) * 100) / 100} MB/s`;
        }
      case "load":
        return value.toFixed(2);
      default:
        return `${value}`;
    }
  }, []);

  // 生成详细的工具提示内容
  const generateDetailedTooltip = useCallback(
    (dataPoint: DataPoint, type: MetricType) => {
      if (!dataPoint.originalMetric) return [];

      const metric = dataPoint.originalMetric;
      const lines: string[] = [];

      // 根据指标类型添加详细信息
      switch (type) {
        case "cpu":
          if (metric.cpu_usage !== undefined)
            lines.push(
              `${t("agent.metrics.cpu.usage")}: ${metric.cpu_usage.toFixed(2)}%`
            );
          if (metric.cpu_cores !== undefined)
            lines.push(`${t("agent.metrics.cpu.cores")}: ${metric.cpu_cores}`);
          if (metric.cpu_model)
            lines.push(`${t("agent.metrics.cpu.model")}: ${metric.cpu_model}`);
          break;

        case "memory":
          if (metric.memory_total !== undefined)
            lines.push(
              `${t("agent.metrics.memory.total")}: ${formatBytes(
                metric.memory_total
              )}`
            );
          if (metric.memory_used !== undefined)
            lines.push(
              `${t("agent.metrics.memory.used")}: ${formatBytes(
                metric.memory_used
              )}`
            );
          if (metric.memory_free !== undefined)
            lines.push(
              `${t("agent.metrics.memory.free")}: ${formatBytes(
                metric.memory_free
              )}`
            );
          if (metric.memory_usage_rate !== undefined)
            lines.push(
              `${t(
                "agent.metrics.memory.usageRate"
              )}: ${metric.memory_usage_rate.toFixed(2)}%`
            );
          break;

        case "disk":
          {
            const selectedDisk = metric.parsedDiskMetrics.find(
              (d) => d.mount_point === selectedDiskDevice
            );

            if (selectedDisk) {
              lines.push(
                `${t("agent.metrics.disk.device")}: ${selectedDisk.device}`
              );
              lines.push(
                `${t("agent.metrics.disk.mountPoint")}: ${
                  selectedDisk.mount_point
                }`
              );
              lines.push(
                `${t("agent.metrics.disk.total")}: ${formatBytes(
                  selectedDisk.total
                )}`
              );
              lines.push(
                `${t("agent.metrics.disk.used")}: ${formatBytes(
                  selectedDisk.used
                )}`
              );
              lines.push(
                `${t("agent.metrics.disk.free")}: ${formatBytes(
                  selectedDisk.free
                )}`
              );
              lines.push(
                `${t(
                  "agent.metrics.disk.usageRate"
                )}: ${selectedDisk.usage_rate.toFixed(2)}%`
              );
              lines.push(
                `${t("agent.metrics.disk.fsType")}: ${selectedDisk.fs_type}`
              );
            }
          }
          break;

        case "network":
          {
            const selectedInterface = metric.parsedNetworkMetrics.find(
              (n) => n.interface === selectedNetworkInterface
            );

            if (selectedInterface) {
              lines.push(
                `${t("agent.metrics.network.interface")}: ${
                  selectedInterface.interface
                }`
              );

              // 显示当前网络速率
              const currentRate = dataPoint.y;
              if (currentRate !== undefined) {
                lines.push(
                  `${t("agent.metrics.network.rate")}: ${getValueDisplayText(
                    "network",
                    currentRate
                  )}`
                );
              }

              // 显示累计数据
              lines.push(
                `${t("agent.metrics.network.sent")}: ${formatBytes(
                  selectedInterface.bytes_sent
                )}`
              );
              lines.push(
                `${t("agent.metrics.network.received")}: ${formatBytes(
                  selectedInterface.bytes_recv
                )}`
              );

              lines.push(
                `${t("agent.metrics.network.packetsSent")}: ${
                  selectedInterface.packets_sent
                }`
              );
              lines.push(
                `${t("agent.metrics.network.packetsReceived")}: ${
                  selectedInterface.packets_recv
                }`
              );
            }
          }
          break;

        case "load":
          if (metric.load_1 !== undefined)
            lines.push(
              `${t("agent.metrics.load.1min")}: ${metric.load_1.toFixed(2)}`
            );
          if (metric.load_5 !== undefined)
            lines.push(
              `${t("agent.metrics.load.5min")}: ${metric.load_5.toFixed(2)}`
            );
          if (metric.load_15 !== undefined)
            lines.push(
              `${t("agent.metrics.load.15min")}: ${metric.load_15.toFixed(2)}`
            );
          break;
      }

      return lines;
    },
    [
      t,
      getValueDisplayText,
      selectedDiskDevice,
      selectedNetworkInterface,
    ]
  );

  // 使用 useMemo 计算并缓存 tooltip 回调函数
  const tooltipCallbacks = useMemo(() => {
    return {
      title: (items: TooltipItem<"line">[]) => {
        if (items.length > 0 && items[0].raw) {
          const dataPoint = items[0].raw as DataPoint;
          return formatTime(new Date(dataPoint.x));
        }
        return "";
      },
      label: (context: TooltipItem<"line">) => {
        const dataPoint = context.raw as DataPoint;
        return generateDetailedTooltip(dataPoint, metricType);
      },
    };
  }, [metricType, formatTime, generateDetailedTooltip]);

  // 使用 useMemo 缓存基础图表选项
  const baseChartOptions = useMemo<ChartOptions<"line">>(() => {
    const config = getMetricConfig(metricType);

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 300,
        easing: "easeOutQuad",
      },
      interaction: {
        mode: "nearest" as const,
        intersect: true,
        axis: "xy" as const,
        includeInvisible: false,
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          titleColor: "white",
          bodyColor: "white",
          titleAlign: "left" as const,
          bodyAlign: "left" as const,
          titleFont: {
            size: 14,
            weight: "bold" as const,
          },
          bodyFont: {
            size: 12,
          },
          padding: 12,
          cornerRadius: 6,
          displayColors: false,
          animation: {
            duration: 200,
            easing: "easeOutQuad",
          },
          callbacks: tooltipCallbacks,
        },
        title: {
          display: true,
          text: config.title,
          align: "start",
          color: "#888",
          font: {
            size: 14,
          },
          padding: { top: 10, bottom: 10 },
        },
      },
      scales: {
        x: {
          type: "linear",
          display: showTimeLabels,
          grid: {
            color: "#e0e0e0",
            lineWidth: 0.5,
          },
          ticks: {
            color: "#888",
            font: {
              size: 10,
            },
            maxRotation: 0,
            autoSkip: false,
            major: {
              enabled: true,
            },
            callback: function (value) {
              const date = new Date(Number(value));
              if (date.getHours() % 2 === 0) {
                return `${date.getHours().toString().padStart(2, "0")}:00`;
              }
              return "";
            },
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "#e0e0e0",
            lineWidth: 0.5,
          },
          ticks: {
            color: "#888",
            font: {
              size: 10,
            },
            callback: (value) => {
              // 对于网络指标，根据数值大小动态调整单位
              if (metricType === "network" && typeof value === "number") {
                if (value < 1024) {
                  return `${value} B/s`;
                } else if (value < 1024 * 1024) {
                  return `${(value / 1024).toFixed(1)} KB/s`;
                } else {
                  return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
                }
              }
              // 其他指标使用固定单位
              return `${value}${config.unit}`;
            },
          },
        },
      },
      hover: {
        mode: "nearest",
        intersect: true,
      },
      animations: {
        colors: {
          duration: 300,
          easing: "easeOutQuad",
        },
        radius: {
          duration: 300,
          easing: "easeOutQuad",
          from: 0,
          to: 4,
          loop: false,
        },
        hover: {
          duration: 300,
          easing: "easeOutQuad",
        },
      },
      events: ["mouseout", "mousemove", "touchstart", "touchmove"],
    };
  }, [showTimeLabels, tooltipCallbacks, metricType, getMetricConfig]);

  // 处理数据并生成图表数据
  const { chartData } = useMemo(() => {
    if (parsedHistory.length === 0) {
      return {
        chartData: {
          datasets: [
            {
              data: [],
              borderColor: getMetricConfig(metricType).color,
              borderWidth: 2,
              backgroundColor: getMetricConfig(metricType).bgColor,
              pointBackgroundColor: [],
              pointBorderColor: [],
              pointRadius: [],
              tension: 0.4,
              pointHoverRadius: 5,
              pointHoverBackgroundColor: "",
              pointHoverBorderColor: "",
              pointHoverBorderWidth: 2,
              pointHitRadius: [],
            },
          ],
        },
        timeRange: null,
        yAxisMax: undefined,
      };
    }

    // 计算24小时前的时间戳
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

    // 根据指标类型处理数据
    let metricsData: DataPoint[] = [];

    // 用于存储上一个网络数据点的信息，计算网速时使用
    let prevNetworkData: {
      timestamp: number;
      interfaces: Record<string, { bytes_sent: number; bytes_recv: number }>;
    } | null = null;

    parsedHistory.forEach((item, idx) => {
      try {
        // 解析时间
        let timestamp: Date;
        try {
          if (item && item.timestamp) {
            timestamp = new Date(item.timestamp);
            if (isNaN(timestamp.getTime())) {
              timestamp = new Date();
            }
          } else {
            timestamp = new Date();
          }
        } catch {
          timestamp = new Date();
        }

        // 不同指标类型的数据处理
        let value: number | undefined;

        switch (metricType) {
          case "cpu":
            value = item.cpu_usage;
            break;
          case "memory":
            value = item.memory_usage_rate;
            break;
          case "disk":
            value = item.parsedDiskMetrics.find(
              (d) => d.mount_point === selectedDiskDevice
            )?.usage_rate;
            break;
          case "network":
            {
              const selectedInterface = item.parsedNetworkMetrics.find(
                (n) => n.interface === selectedNetworkInterface
              );

              // 计算网络速率
              if (selectedInterface) {
                const currentTimestamp = timestamp.getTime();
                const currentBytes =
                  selectedNetworkMetric === "received"
                    ? selectedInterface.bytes_recv
                    : selectedInterface.bytes_sent;

                // 如果有前一个数据点，计算速率
                if (
                  prevNetworkData &&
                  prevNetworkData.interfaces[selectedNetworkInterface] &&
                  currentTimestamp > prevNetworkData.timestamp
                ) {
                  const prevBytes =
                    selectedNetworkMetric === "received"
                      ? prevNetworkData.interfaces[selectedNetworkInterface]
                          .bytes_recv
                      : prevNetworkData.interfaces[selectedNetworkInterface]
                          .bytes_sent;

                  // 计算时间差（秒）
                  const timeDiff =
                    (currentTimestamp - prevNetworkData.timestamp) / 1000;

                  // 如果时间差大于0且当前字节数大于等于前一个字节数，计算速率
                  if (timeDiff > 0 && currentBytes >= prevBytes) {
                    // 计算速率（字节/秒）
                    value = (currentBytes - prevBytes) / timeDiff;
                  } else {
                    // 如果数据异常（如计数器重置），则跳过该点
                    value = undefined;
                  }
                } else {
                  // 第一个数据点，无法计算速率
                  value = undefined;
                }

                // 更新前一个数据点信息
                if (!prevNetworkData) {
                  prevNetworkData = {
                    timestamp: currentTimestamp,
                    interfaces: {},
                  };
                }

                // 保存当前接口的数据
                if (!prevNetworkData.interfaces[selectedNetworkInterface]) {
                  prevNetworkData.interfaces[selectedNetworkInterface] = {
                    bytes_sent: 0,
                    bytes_recv: 0,
                  };
                }

                prevNetworkData.timestamp = currentTimestamp;
                prevNetworkData.interfaces[
                  selectedNetworkInterface
                ].bytes_sent = selectedInterface.bytes_sent;
                prevNetworkData.interfaces[
                  selectedNetworkInterface
                ].bytes_recv = selectedInterface.bytes_recv;
              }
            }
            break;
          case "load":
            switch (selectedLoadType) {
              case "1":
                value = item.load_1;
                break;
              case "5":
                value = item.load_5;
                break;
              case "15":
                value = item.load_15;
                break;
            }
            break;
        }

        // 只添加有效的数据点
        if (value !== undefined && !isNaN(value)) {
          metricsData.push({
            x: timestamp.getTime(),
            y: value,
            originalValue: value,
            originalMetric: item, // 存储完整的原始指标数据
            originalIndex: idx,
          });
        }
      } catch (e) {
        console.error(`处理${metricType}数据点失败:`, e);
      }
    });

    // 过滤24小时前的数据并排序
    metricsData = metricsData
      .filter((point) => point.x >= twentyFourHoursAgo)
      .sort((a, b) => a.x - b.x);

    // 确保相邻点至少间隔1分钟
    const oneMinute = 60 * 1000;
    const filteredData: DataPoint[] = [];

    if (metricsData.length > 0) {
      filteredData.push(metricsData[0]);

      for (let i = 1; i < metricsData.length; i++) {
        const lastAddedTime = filteredData[filteredData.length - 1].x;
        const currentTime = metricsData[i].x;

        if (currentTime - lastAddedTime >= oneMinute) {
          filteredData.push(metricsData[i]);
        }
      }
    }

    if (filteredData.length === 0) {
      return {
        chartData: {
          datasets: [
            {
              data: [],
              borderColor: getMetricConfig(metricType).color,
              borderWidth: 2,
              backgroundColor: getMetricConfig(metricType).bgColor,
              pointBackgroundColor: [],
              pointBorderColor: [],
              pointRadius: [],
              tension: 0.4,
              pointHoverRadius: 5,
              pointHoverBackgroundColor: "",
              pointHoverBorderColor: "",
              pointHoverBorderWidth: 2,
              pointHitRadius: [],
            },
          ],
        },
        timeRange: null,
        yAxisMax: undefined,
      };
    }

    // 最终使用的数据点
    metricsData = filteredData;

    // 计算最大值，用于设置y轴
    const maxValue = Math.max(...metricsData.map((point) => point.y || 0));

    // 设置y轴最大值（根据不同指标类型进行调整）
    let calculatedYAxisMax: number | undefined;

    switch (metricType) {
      case "cpu":
      case "memory":
      case "disk":
        // 百分比图表，最大值不超过100%
        calculatedYAxisMax = Math.min(Math.ceil(maxValue * 1.1), 100);
        break;
      case "network":
        // 网络流量，动态调整
        calculatedYAxisMax =
          maxValue < 1000000 ? Math.ceil(maxValue * 1.1) : undefined;
        break;
      case "load":
        // 系统负载，动态调整
        calculatedYAxisMax =
          maxValue < 10 ? Math.ceil(maxValue * 1.5) : Math.ceil(maxValue * 1.2);
        break;
      default:
        calculatedYAxisMax = Math.ceil(maxValue * 1.1);
    }

    // 时间范围
    let timeRangeData = null;
    if (metricsData.length > 0) {
      const oldestTime = metricsData[0].x;
      const newestTime = metricsData[metricsData.length - 1].x;
      timeRangeData = { min: oldestTime, max: newestTime };
    }

    // 处理点的样式
    const pointBackgroundColors: string[] = [];
    const pointBorderColors: string[] = [];
    const pointRadii: number[] = [];
    const pointHitRadii: number[] = [];

    // 设置点的样式
    metricsData.forEach(() => {
      pointBackgroundColors.push("rgba(0, 0, 0, 0)");
      pointBorderColors.push("rgba(0, 0, 0, 0)");
      pointRadii.push(0);
      pointHitRadii.push(20);
    });

    const config = getMetricConfig(metricType);

    // 返回处理后的数据
    return {
      chartData: {
        datasets: [
          {
            data: metricsData,
            borderColor: config.color,
            borderWidth: 2,
            backgroundColor: config.bgColor,
            pointBackgroundColor: pointBackgroundColors,
            pointBorderColor: pointBorderColors,
            pointRadius: pointRadii,
            tension: 0.4,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: config.color,
            pointHoverBorderColor: config.color,
            pointHoverBorderWidth: 2,
            pointHitRadius: pointHitRadii,
          },
        ],
      },
      timeRange: timeRangeData,
      yAxisMax: calculatedYAxisMax,
    };
  }, [
    parsedHistory,
    metricType,
    selectedDiskDevice,
    selectedNetworkInterface,
    selectedNetworkMetric,
    selectedLoadType,
    getMetricConfig,
  ]);

  // 渲染设备选择器
  const renderDeviceSelector = () => {
    if (metricType === "disk" && availableDiskDevices.length > 0) {
      return (
        <Box mb="2">
          <Select
            value={selectedDiskDevice}
            onValueChange={setSelectedDiskDevice}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableDiskDevices.map((device) => (
                <SelectItem key={device.value} value={device.value}>
                  {device.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Box>
      );
    }

    if (metricType === "network" && availableNetworkInterfaces.length > 0) {
      return (
        <Flex gap="2" mb="2" align="center">
          <Select
            value={selectedNetworkInterface}
            onValueChange={setSelectedNetworkInterface}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableNetworkInterfaces.map((iface) => (
                <SelectItem key={iface.value} value={iface.value}>
                  {iface.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={selectedNetworkMetric}
            onValueChange={(value) =>
              setSelectedNetworkMetric(value as "received" | "sent")
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="received">
                {t("agent.metrics.network.received")}
              </SelectItem>
              <SelectItem value="sent">
                {t("agent.metrics.network.sent")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Flex>
      );
    }

    // 添加 load 类型选择器
    if (metricType === "load") {
      return (
        <Box mb="2">
          <Select
            value={selectedLoadType}
            onValueChange={(value) =>
              setSelectedLoadType(value as "1" | "5" | "15")
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t("agent.metrics.load.1min")}</SelectItem>
              <SelectItem value="5">{t("agent.metrics.load.5min")}</SelectItem>
              <SelectItem value="15">
                {t("agent.metrics.load.15min")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Box>
      );
    }

    return null;
  };

  return (
    <Box>
      {renderDeviceSelector()}
      <Box style={{ height: `${height}px`, position: "relative" }}>
        <Line ref={chartRef} data={chartData} options={baseChartOptions} />
      </Box>
    </Box>
  );
};

export default MetricsChart;
