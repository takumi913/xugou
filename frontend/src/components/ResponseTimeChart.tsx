import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { Box } from "@/components/ui/theme-shim";
import { MonitorStatusHistory } from "../types/monitors";
import { useTranslation } from "react-i18next";
import { Line } from "react-chartjs-2";
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

interface ResponseTimeChartProps {
  history?: MonitorStatusHistory[];
  height?: number;
  showTimeLabels?: boolean;
}

interface DataPoint {
  x: number; // 时间戳（毫秒）
  y: number; // 响应时间（毫秒）
  status: "up" | "down"; // 状态
  originalIndex?: number; // 原始数据索引
  response_time?: number; // 直接存储原始的响应时间，方便调试
}

const ResponseTimeChart: React.FC<ResponseTimeChartProps> = ({
  history = [],
  height = 200,
  showTimeLabels = true,
}) => {
  const { t } = useTranslation();
  const chartRef = useRef<ChartJS<"line">>(null);

  // 格式化时间的函数使用 useCallback 缓存
  const formatTime = useCallback((date: Date) => {
    try {
      // 检查日期是否有效
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        return "无效日期";
      }

      // 统一使用本地时间格式，确保在客户端一致显示
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

        // 确保有清晰明确的属性显示
        return [
          `${t("monitor.history.responseTime")}: ${Math.round(
            dataPoint.y || 0
          )}ms`,
          `${t("common.status")}: ${
            dataPoint.status === "up"
              ? t("monitor.status.normal")
              : t("monitor.status.failure")
          }`,
        ];
      },
    };
  }, [t, formatTime]);

  // 使用 useMemo 缓存基础图表选项，只有在显示标签更改时才更新
  const baseChartOptions = useMemo<ChartOptions<"line">>(() => {
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
          backgroundColor: "rgba(0, 0, 0, 0.6)",
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
          padding: 10,
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
          text: t("monitor.history.responseTime"),
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
            callback: (value) => `${value}ms`,
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
  }, [t, showTimeLabels, tooltipCallbacks]);

  // 处理数据并生成图表数据，使用 useMemo 缓存结果
  const { chartData, timeRange, yAxisMax } = useMemo(() => {
    if (history.length === 0) {
      return {
        chartData: {
          datasets: [
            {
              data: [],
              borderColor: "rgba(72, 161, 245, 0.8)",
              borderWidth: 2,
              backgroundColor: "rgba(72, 161, 245, 0.1)",
              pointBackgroundColor: [],
              pointBorderColor: [],
              pointRadius: [],
              tension: 0.4,
              pointHoverRadius: 0,
              pointHoverBackgroundColor: "",
              pointHoverBorderColor: "",
              pointHoverBorderWidth: 0,
              pointHitRadius: [],
            },
          ],
        },
        timeRange: null,
        yAxisMax: undefined,
      };
    }

    // 预处理数据，确保所有数据结构正确
    const processedHistory = history.map((item) => {
      const status: "up" | "down" = item.status === "down" ? "down" : "up";
      return {
        ...item,
        status,
        response_time: item.response_time || 0,
      };
    });

    // 计算24小时前的时间戳
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

    // 提取响应时间数据
    let responseTimeData: DataPoint[] = processedHistory
      .map((item, idx) => {
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

          // 使用响应时间，或者默认值0
          const responseTime =
            item && item.response_time !== undefined && item.response_time > 0
              ? item.response_time
              : 0;

          // 确保类型为 'up' | 'down'
          const status: "up" | "down" = item.status === "down" ? "down" : "up";

          const result: DataPoint = {
            x: timestamp.getTime(),
            y: responseTime,
            status,
            response_time: responseTime,
            originalIndex: idx,
          };

          return result;
        } catch {
          return {
            x: new Date().getTime(),
            y: 0,
            status: "up" as const,
            response_time: 0,
            originalIndex: idx,
          } as DataPoint;
        }
      })
      .filter((point) => point.x >= twentyFourHoursAgo)
      .sort((a, b) => a.x - b.x);

    // 确保相邻点至少间隔1分钟
    const oneMinute = 60 * 1000;
    const filteredData: DataPoint[] = [];

    if (responseTimeData.length > 0) {
      filteredData.push(responseTimeData[0]);

      for (let i = 1; i < responseTimeData.length; i++) {
        const lastAddedTime = filteredData[filteredData.length - 1].x;
        const currentTime = responseTimeData[i].x;

        if (currentTime - lastAddedTime >= oneMinute) {
          filteredData.push(responseTimeData[i]);
        }
      }
    }

    if (filteredData.length === 0) {
      return {
        chartData: {
          datasets: [
            {
              data: [],
              borderColor: "rgba(72, 161, 245, 0.8)",
              borderWidth: 2,
              backgroundColor: "rgba(72, 161, 245, 0.1)",
              pointBackgroundColor: [],
              pointBorderColor: [],
              pointRadius: [],
              tension: 0.4,
              pointHoverRadius: 0,
              pointHoverBackgroundColor: "",
              pointHoverBorderColor: "",
              pointHoverBorderWidth: 0,
              pointHitRadius: [],
            },
          ],
        },
        timeRange: null,
        yAxisMax: undefined,
      };
    }

    // 最终使用的数据点
    responseTimeData = filteredData;

    // 计算最大响应时间，用于设置y轴
    const maxResponseTime = Math.max(
      ...responseTimeData.map((point) => point.y || 0)
    );

    // 设置y轴最大值
    const calculatedYAxisMax =
      maxResponseTime < 10000 ? Math.ceil(maxResponseTime * 1.1) : 10000;

    // 时间范围
    let timeRangeData = null;
    if (responseTimeData.length > 0) {
      const oldestTime = responseTimeData[0].x;
      const newestTime = responseTimeData[responseTimeData.length - 1].x;
      timeRangeData = { min: oldestTime, max: newestTime };
    }

    // 处理点的样式
    const pointBackgroundColors: string[] = [];
    const pointBorderColors: string[] = [];
    const pointRadii: number[] = [];
    const pointHitRadii: number[] = [];

    // 根据数据点状态设置不同的样式
    responseTimeData.forEach(() => {
      pointBackgroundColors.push("rgba(0, 0, 0, 0)");
      pointBorderColors.push("rgba(0, 0, 0, 0)");
      pointRadii.push(0);
      pointHitRadii.push(20);
    });

    // 返回处理后的数据
    return {
      chartData: {
        datasets: [
          {
            data: responseTimeData,
            borderColor: "rgba(128, 128, 128, 0.8)",
            borderWidth: 2,
            backgroundColor: "rgba(128, 128, 128, 0.1)",
            pointBackgroundColor: pointBackgroundColors,
            pointBorderColor: pointBorderColors,
            pointRadius: pointRadii,
            tension: 0.4,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: "rgba(128, 128, 128, 0.7)",
            pointHoverBorderColor: "rgba(128, 128, 128, 0.9)",
            pointHoverBorderWidth: 2,
            pointHitRadius: pointHitRadii,
          },
        ],
      },
      timeRange: timeRangeData,
      yAxisMax: calculatedYAxisMax,
    };
  }, [history]);

  // 合并基础选项和动态选项，使用 useMemo 缓存最终选项
  const finalChartOptions = useMemo<ChartOptions<"line">>(() => {
    // 如果没有时间范围数据，使用基础选项
    if (!timeRange) return baseChartOptions;

    // 合并时间范围和y轴最大值到选项中
    return {
      ...baseChartOptions,
      scales: {
        ...baseChartOptions.scales,
        x: {
          ...baseChartOptions.scales?.x,
          min: timeRange.min,
          max: timeRange.max,
        },
        y: {
          ...baseChartOptions.scales?.y,
          max: yAxisMax,
        },
      },
    };
  }, [baseChartOptions, timeRange, yAxisMax]);

  // 单一的 useEffect 用于更新图表实例
  useEffect(() => {
    if (!chartRef.current) return;

    // 直接更新图表实例
    chartRef.current.update();
  }, [finalChartOptions]);

  // 如果没有数据，显示空图表和提示信息
  if (!chartData.datasets[0].data.length) {
    return (
      <Box
        style={{
          width: "100%",
          height: `${height}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "var(--gray-1)",
          borderRadius: "4px",
          color: "gray",
          fontSize: "14px",
        }}
      >
        {t("monitor.noResponseTimeData")}
      </Box>
    );
  }

  return (
    <Box
      style={{
        width: "100%",
        paddingTop: "10px",
        paddingBottom: "10px",
        position: "relative",
        overflow: "visible",
      }}
    >
      <div
        style={{
          width: "100%",
          height: `${height}px`,
          borderRadius: "4px",
          backgroundColor: "var(--gray-1)",
        }}
      >
        <Line ref={chartRef} data={chartData} options={finalChartOptions} />
      </div>
    </Box>
  );
};

export default ResponseTimeChart;
