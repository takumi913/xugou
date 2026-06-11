import { Text } from "@/components/ui/theme-shim";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectSeparator,
  SelectValue,
  SelectGroup,
} from "./ui";

// 状态码选项定义
export const specificStatusCodes = [
  {
    group: "2xx - 成功",
    codes: [
      { label: "2xx - 所有成功状态码", value: 2, isRange: true },
      { label: "200 - OK", value: 200 },
      { label: "201 - Created", value: 201 },
      { label: "204 - No Content", value: 204 },
    ],
  },
  {
    group: "3xx - 重定向",
    codes: [
      { label: "3xx - 所有重定向状态码", value: 3, isRange: true },
      { label: "301 - Moved Permanently", value: 301 },
      { label: "302 - Found", value: 302 },
      { label: "304 - Not Modified", value: 304 },
    ],
  },
  {
    group: "4xx - 客户端错误",
    codes: [
      { label: "4xx - 所有客户端错误状态码", value: 4, isRange: true },
      { label: "400 - Bad Request", value: 400 },
      { label: "401 - Unauthorized", value: 401 },
      { label: "403 - Forbidden", value: 403 },
      { label: "404 - Not Found", value: 404 },
    ],
  },
  {
    group: "5xx - 服务器错误",
    codes: [
      { label: "5xx - 所有服务器错误状态码", value: 5, isRange: true },
      { label: "500 - Internal Server Error", value: 500 },
      { label: "502 - Bad Gateway", value: 502 },
      { label: "503 - Service Unavailable", value: 503 },
      { label: "504 - Gateway Timeout", value: 504 },
    ],
  },
];

interface StatusCodeSelectProps {
  value: number | string;
  onChange: (value: number) => void;
  name?: string;
  required?: boolean;
}

/**
 * 预期状态码选择组件
 * 提供HTTP状态码和状态码范围的选择功能
 */
const StatusCodeSelect = ({
  value,
  onChange,
  name = "expectedStatus",
  required = false,
}: StatusCodeSelectProps) => {
  return (
    <>
      <Select
        name={name}
        value={value.toString()}
        onValueChange={(value) => onChange(parseInt(value))}
        required={required}
      >
        <SelectTrigger style={{ width: "100%" }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={5}>
          {specificStatusCodes.map((group) => (
            <SelectGroup key={group.group}>
              <SelectLabel>{group.group}</SelectLabel>
              {group.codes.map((code) => (
                <SelectItem key={code.value} value={code.value.toString()}>
                  {code.label}
                </SelectItem>
              ))}
              {group !==
                specificStatusCodes[specificStatusCodes.length - 1] && (
                <SelectSeparator style={{ margin: "8px 0" }} />
              )}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Text size="1" color="gray" style={{ marginTop: "4px" }}>
        选择预期的HTTP状态码或状态码范围
      </Text>
    </>
  );
};

export default StatusCodeSelect;
