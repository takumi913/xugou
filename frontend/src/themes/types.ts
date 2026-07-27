/**
 * 主题系统类型契约（可插拔主题的唯一规范来源）
 *
 * 一个主题 = frontend/src/themes/<id>/ 下的两个文件：
 *   - theme.css：以 :root[data-theme="<id>"]（深色）与
 *     :root[data-theme="<id>"].light（浅色）两个块定义全部语义 CSS 变量
 *   - index.ts：默认导出满足 ThemeManifest 的清单对象
 *
 * 完整的变量清单、命名规则与新增主题步骤见 frontend/src/themes/README.md。
 */

/**
 * chart.js 数据线色板。
 * 画布渲染无法解析 var(--xxx)，因此图表色必须在清单中以 hex 提供，
 * 且深浅两种模式各一套（键名与图表语义一一对应）。
 */
export interface ChartSeriesColors {
  /** CPU 使用率曲线 */
  cpu: string;
  /** 内存使用率曲线 */
  memory: string;
  /** 磁盘使用率曲线 */
  disk: string;
  /** 下行网速曲线 */
  netDown: string;
  /** 上行网速曲线 */
  netUp: string;
  /** 进程数等次要曲线 */
  process: string;
  /** 兜底/第二序列 */
  secondary: string;
}

/** chart.js 轴/网格/tooltip 配色（同样必须是真实色值） */
export interface ChartUiColors {
  gridColor: string;
  tickColor: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipTitle: string;
  tooltipBody: string;
}

/** 主题清单：主题的元信息与画布配色（CSS 变量部分在 theme.css 中） */
export interface ThemeManifest {
  /** 主题 id：必须与文件夹名一致，kebab-case，匹配 /^[a-z0-9][a-z0-9-]{0,31}$/ */
  id: string;
  /** 显示名（主题列表卡片标题） */
  name: string;
  /** 一句话描述（主题列表卡片副标题） */
  description: string;
  /** 作者（可选，展示在主题卡片上） */
  author?: string;
  /** 语义化版本（可选） */
  version?: string;
  /**
   * 主题列表卡片的色板预览：4~6 个代表色（建议取深色模式下的
   * 背景、主强调、次强调、告警等），按展示顺序排列
   */
  preview: string[];
  /** 图表数据线色板（深/浅两套均必填） */
  chart: {
    dark: ChartSeriesColors;
    light: ChartSeriesColors;
  };
  /** 图表轴/网格/tooltip 配色（深/浅两套均必填） */
  chartUi: {
    dark: ChartUiColors;
    light: ChartUiColors;
  };
}

/** 主题 id 的合法格式（与后端 statusPageConfigSchema 的校验保持一致） */
export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
