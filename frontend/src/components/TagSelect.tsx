import { useTranslation } from "react-i18next";

export interface TagSelectOption {
  id: number;
  label: string;
  /** 药丸内括号里的次要说明（如渠道类型） */
  hint?: string;
}

interface TagSelectProps {
  options: TagSelectOption[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  /** 无可选项时的提示文案（缺省 common.noData） */
  emptyText?: string;
  /** 显示 全选/清空 快捷操作与计数（选项较多的场景建议开启） */
  bulkActions?: boolean;
}

/**
 * 标签式多选（终端药丸风格，与仪表盘地区筛选同一视觉语言）：
 * 所有选项平铺可见，点击切换选中——替代带边框的下拉多选与复选框长列表。
 */
const TagSelect = ({
  options,
  selectedIds,
  onChange,
  emptyText,
  bulkActions = false,
}: TagSelectProps) => {
  const { t } = useTranslation();

  if (options.length === 0) {
    return <div className="empty-state">{emptyText ?? t("common.noData")}</div>;
  }

  const selected = new Set(selectedIds);
  const toggle = (id: number) => {
    onChange(
      selected.has(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id]
    );
  };

  return (
    <div>
      <div className="tag-select" role="group">
        {options.map((option) => {
          const isSelected = selected.has(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`filter-tag${isSelected ? " active" : ""}`}
              aria-pressed={isSelected}
              onClick={() => toggle(option.id)}
            >
              <span aria-hidden>{isSelected ? "✓" : "+"}</span>
              {option.label}
              {option.hint && (
                <span style={{ opacity: 0.7 }}>({option.hint})</span>
              )}
            </button>
          );
        })}
      </div>
      {bulkActions && options.length > 1 && (
        <div className="tag-select-actions">
          <button
            type="button"
            onClick={() => onChange(options.map((option) => option.id))}
          >
            {t("tagSelect.selectAll")}
          </button>
          <span aria-hidden>/</span>
          <button type="button" onClick={() => onChange([])}>
            {t("tagSelect.clear")}
          </button>
          <span className="tag-select-count">
            {selectedIds.length}/{options.length}
          </span>
        </div>
      )}
    </div>
  );
};

export default TagSelect;
