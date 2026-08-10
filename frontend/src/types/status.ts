/**
 * 状态页面相关类型定义
 */

import type { components } from "../api/generated/v2-schema";

export type StatusPageConfigResponse = components["schemas"]["StatusConfigView"];

export type StatusPageConfig = components["schemas"]["StatusConfigCommand"];
export type StatusPageData = components["schemas"]["PublicStatus"];
