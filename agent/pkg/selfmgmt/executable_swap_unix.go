//go:build !windows

package selfmgmt

import (
	"fmt"
	"os"
)

func installExecutable(newPath, target, backup string) error {
	if err := os.Remove(backup); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("清理旧备份失败: %w", err)
	}
	if err := os.Rename(target, backup); err != nil {
		return fmt.Errorf("备份旧版本失败: %w", err)
	}
	if err := os.Rename(newPath, target); err != nil {
		if restoreErr := os.Rename(backup, target); restoreErr != nil {
			return fmt.Errorf("安装新版本失败: %v；恢复旧版本失败: %w", err, restoreErr)
		}
		return fmt.Errorf("安装新版本失败，旧版本已恢复: %w", err)
	}
	return nil
}

func restoreExecutable(target, backup string) error {
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(backup, target)
}
